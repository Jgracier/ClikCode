/** A turn on one account (`POST /v1/turns`), streamed as NDJSON events.
 *
 * The turn itself is ClikCode's own (turn/session-turn.ts runSessionTurn,
 * the one entry every caller uses), run on a conversation made for it and
 * pinned to the account asked for: a refusal there ends the turn with its
 * reason instead of moving it to another account (TurnRunOptions.
 * pinnedAccount). What the turn shows -- its text, its tool calls, its usage
 * -- arrives through the TurnObserver every surface implements; this one
 * writes events. Why it failed is ClikCode's own classification of the
 * vendor's refusal (turn/failover.ts), said in the service API's reasons. */
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import type { TurnObserver } from '../turn/observer.js';
import { SignInEnded } from '../turn/observer.js';
import type { AccountFailureKind } from '../turn/failover.js';
import { isTurnCancelled } from '../agent/cancellation.js';
import { isUsageExhaustedMessage } from '../turn/usage-exhausted.js';
import { redactForLog } from '../runtime/redact.js';

export type ErrorReason = 'needs-login' | 'revoked' | 'limited' | 'not-entitled' | 'model-unavailable' | 'timeout' | 'crashed';

export type TurnEvent =
  | { type: 'text'; text: string; replace?: true }
  | { type: 'tool'; name: string; status: 'started' | 'done' | 'error' }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; reason: ErrorReason; message: string; retryAfterSec?: number };

export interface TurnRequest {
  accountId: string;
  model?: string;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  mcp?: { url: string; headers?: Record<string, string> };
  maxTurns?: number;
  timeoutMs?: number;
}

/** The longest a turn may run when its caller names no limit, and the most it may name. */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
export const MAX_TURN_TIMEOUT_MS = 60 * 60_000;

/** A turn request read from its JSON body, or the reason it is not one. */
export function parseTurnRequest(body: unknown): TurnRequest | { error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.accountId !== 'string' || !input.accountId) return { error: 'accountId is required' };
  if (!Array.isArray(input.messages) || !input.messages.length) return { error: 'messages must be a non-empty array' };
  const messages: TurnRequest['messages'] = [];
  for (const message of input.messages as unknown[]) {
    const item = message as { role?: unknown; content?: unknown };
    if (typeof item?.role !== 'string' || typeof item.content !== 'string') return { error: 'each message is { role, content } with string content' };
    messages.push({ role: item.role, content: item.content });
  }
  if (messages.at(-1)!.role !== 'user') return { error: 'the last message must be the user\'s' };
  if (input.model !== undefined && typeof input.model !== 'string') return { error: 'model must be a string' };
  if (input.system !== undefined && typeof input.system !== 'string') return { error: 'system must be a string' };
  let mcp: TurnRequest['mcp'];
  if (input.mcp !== undefined && input.mcp !== null) {
    const given = input.mcp as { url?: unknown; headers?: unknown };
    if (typeof given.url !== 'string' || !/^https?:\/\//i.test(given.url)) return { error: 'mcp.url must be an http(s) URL' };
    const headers = given.headers === undefined ? {} : given.headers;
    if (!headers || typeof headers !== 'object' || Object.values(headers).some((value) => typeof value !== 'string')) return { error: 'mcp.headers must be an object of strings' };
    mcp = { url: given.url, headers: headers as Record<string, string> };
  }
  const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  return {
    accountId: input.accountId, messages,
    ...(input.model ? { model: input.model as string } : {}),
    ...(input.system ? { system: input.system as string } : {}),
    ...(mcp ? { mcp } : {}),
    ...(number(input.maxTurns) ? { maxTurns: Math.floor(number(input.maxTurns)!) } : {}),
    ...(number(input.timeoutMs) ? { timeoutMs: Math.min(MAX_TURN_TIMEOUT_MS, number(input.timeoutMs)!) } : {}),
  };
}

/** The one request a turn sends: the caller's conversation, with its
 * instructions first, ending on the user's message. A single user message
 * with no instructions is sent as it is. */
export function turnPrompt(request: Pick<TurnRequest, 'system' | 'messages'>): string {
  const last = request.messages.at(-1)!;
  const earlier = request.messages.slice(0, -1);
  if (!request.system && !earlier.length) return last.content;
  const parts: string[] = [];
  if (request.system) parts.push(`<instructions>\n${request.system}\n</instructions>`);
  if (earlier.length) {
    parts.push(`<conversation>\n${earlier.map((message) => `<${tag(message.role)}>\n${message.content}\n</${tag(message.role)}>`).join('\n')}\n</conversation>`);
  }
  parts.push(last.content);
  return parts.join('\n\n');
}

const tag = (role: string): string => (/^[a-z][a-z0-9_-]*$/i.test(role) ? role.toLowerCase() : 'message');

/** Why a turn failed, in the service API's reasons -- mapped 1:1 onto the
 * Gateway's route verdicts (limited: cooling; needs-login, revoked: the
 * account held; not-entitled, model-unavailable: the model held). `kind`
 * is ClikCode's own classification (classifyTurnFailure). */
export function errorReason(error: unknown, kind: AccountFailureKind, options: { timedOut?: boolean } = {}): ErrorReason {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (options.timedOut) return 'timeout';
  if (isUsageExhaustedMessage(message)) return 'limited';
  // The plan does not cover it (an eligibility refusal) before the model's own absence.
  if (kind === 'account-ineligible') return /\bmodel\b/i.test(message) ? 'not-entitled' : /verify|verification|past due|suspend|disabled|banned/i.test(message) ? 'revoked' : 'not-entitled';
  if (/is not available through local account|model[^.\n]{0,40}\b(?:not found|not available|unavailable|does not exist|not supported)\b|unknown model|invalid model|model_not_found/i.test(message)) return 'model-unavailable';
  switch (kind) {
    case 'authentication-required':
      return /\brevoked\b/i.test(message) ? 'revoked' : 'needs-login';
    case 'quota-exhausted':
    case 'temporarily-throttled':
      return 'limited';
    case 'request-invalid':
      return /\bmodel\b/i.test(message) ? 'model-unavailable' : 'crashed';
    default:
      return 'crashed';
  }
}

/** Seconds until `at`, for a `limited` refusal that named when the account is back. */
export function retryAfterSeconds(at: string | undefined, now = Date.now()): number | undefined {
  const when = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(when) && when > now ? Math.ceil((when - now) / 1000) : undefined;
}

/** An error's message as the caller may see it: nothing shaped like a credential, one paragraph. */
export function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? 'the turn failed');
  return redactForLog(text).trim().slice(0, 2_000) || 'the turn failed';
}

/** The TurnObserver of a service turn: what the turn shows, as events. */
export class EventObserver implements TurnObserver {
  private shown = '';
  private usage: TurnUsage | undefined;
  private readonly calls = new Map<string, string>();

  constructor(private readonly emit: (event: TurnEvent) => void) {}

  /** Everything the turn's answer said, as shown. */
  get text(): string { return this.shown; }
  get lastUsage(): TurnUsage | undefined { return this.usage; }

  render(): void { /* nothing to draw */ }
  response(text: string, mode: 'append' | 'replace' = 'append'): void {
    if (mode === 'append') {
      if (!text) return;
      this.shown += text;
      this.emit({ type: 'text', text });
      return;
    }
    if (text === this.shown) return;
    if (text.startsWith(this.shown)) {
      const more = text.slice(this.shown.length);
      this.shown = text;
      this.emit({ type: 'text', text: more });
      return;
    }
    this.shown = text;
    this.emit({ type: 'text', text, replace: true });
  }
  activity(): void { /* ClikCode's own notices: not the answer */ }
  activityEvent(event: HarnessActivityEvent): void {
    if (event.kind === 'thinking') return;
    const status = event.kind === 'tool-start' ? 'started' : event.kind === 'tool-done' ? 'done' : 'error';
    // A call arrives in several frames: each status once.
    const id = event.id ?? event.label;
    if (this.calls.get(id) === status) return;
    this.calls.set(id, status);
    this.emit({ type: 'tool', name: event.call?.name ?? event.label, status });
  }
  phase(): void { /* status-line text */ }
  /** No one to ask: the turn runs in bypass, and what it still asks about is allowed once. */
  async approval(): Promise<boolean> { return true; }
  setPlan(): void { /* not part of the stream */ }
  setTurnUsage(usage: TurnUsage): void { this.usage = { ...this.usage, ...usage }; }
  startWaiting(): void { /* nothing to draw */ }
  stopWaiting(): void { /* nothing to draw */ }
  /** A sign-in the turn wants is not run here: the account is reported as needing one. */
  async signIn(): Promise<void> { throw new SignInEnded('no one can sign in during a service turn', 'unavailable'); }

  /** The usage and done events of a turn that finished. */
  finish(): void {
    const usage = this.usage;
    this.emit({
      type: 'usage', inputTokens: usage?.input ?? 0, outputTokens: usage?.output ?? 0,
      ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      // As the vendor counts them: Claude's input excludes cache reads, Codex's includes them.
      ...(usage?.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
      ...(usage?.cacheWrite !== undefined ? { cacheWriteTokens: usage.cacheWrite } : {}),
    });
    this.emit({ type: 'done', stopReason: usage?.stopReason ?? 'completed' });
  }
}

export { isTurnCancelled };

/**
 * What a turn needs in order to run, independent of who asked for it.
 *
 * A turn is not a single call: it reuses a long-lived app-server or ACP child
 * across sends, carries an environment derived from the account, can fail over
 * mid-flight to another account, names the session from its first exchange,
 * and must survive the process dying halfway through. The interactive loop and
 * the command surface both drive turns, so this layer sits under both rather
 * than inside either.
 */
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { stdin as input } from 'node:process';
import { usageLabelIsExhausted, usageLabelRemainingPercent } from './failover.js';
import { normalizeSessionTitle } from '../session/title.js';
import { ADOPTED_TRANSCRIPT_READERS } from '../session/discovery/registry.js';
import { mergeNativeTranscript } from '../session/discovery/transcript.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { HarnessDefaultSettings, HarnessSession, HarnessState } from '../session/model.js';
import type { HarnessAvailableCommand } from '../harness/events/turn-observer.js';
import type { TerminalHarnessPrompter } from '../tui/prompter.js';
import { nativeProfileEnvironment } from '../harness/transport/profile-environment.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { accountUsageLabel } from '../harness/accounts/account-usage.js';
import { createCodexSession } from '../harness/transport/codex-app-server.js';
import { createAcpSession } from '../harness/transport/acp-client.js';
import { homeRedirectEnvironment } from '../runtime/lazy-bridge.js';
import { conversationIdFor } from '../session/options.js';
import { existsSync } from 'node:fs';
import { LiveTurnInputBroker } from './live-input.js';
import { beginPendingTurn, consumeSessionTurn, discardPendingTurn, enqueueSessionTurn, finishPendingTurn, recordPendingActivity, recordPendingSteer, sessionTranscriptMessages, updatePendingResponse } from './checkpoint.js';

import type { HarnessTurnTransport } from '../harness/transport/select.js';
import type { CodexSession } from '../harness/transport/codex-app-server.js';
import type { AcpSession } from '../harness/transport/acp-client.js';
import type { LiveTurnSubmission } from './live-input.js';

export interface TurnRunOptions {
  liveInput?: LiveTurnInputBroker;
  queuedTurnId?: string;
  /** The interactive loop keeps ONE app-server / ACP child per open session
   * and closes it itself; headless sends stay one-shot. */
  persistentTransports?: boolean;
  /** Who is watching this turn, explicitly -- never read from a global. A
   * headless caller (CLI, daemon, a slash command with no terminal) omits
   * this and gets the plain stdout/emitHarnessOutput fallback every
   * TERMINAL.active check used to fall back to on its own. */
  prompter?: TerminalHarnessPrompter;
}


/** Harnesses whose `experimental` structured turn this process saw rejected;
 * later turns go straight to the catalog's proven `fallbackTurn`. */
export const fallbackTurnHarnesses = new Set<string>();

/** ACP `available_commands_update`, per ClikCode session, for the slash registry. */
export const nativeAvailableCommands = new Map<string, readonly HarnessAvailableCommand[]>();
export function sessionNativeCommands(sessionId: string): readonly HarnessAvailableCommand[] {
  return nativeAvailableCommands.get(sessionId) ?? [];
}

interface PersistentTransport { key: string; transport: HarnessTurnTransport; session: CodexSession | AcpSession }
export const persistentTransports = new Map<string, PersistentTransport>();
/** Test seam: the transport session factories. */
const TRANSPORT_SESSIONS = { codex: createCodexSession, acp: createAcpSession };

/** One live child per open ClikCode session, keyed by everything that makes a
 * child reusable (harness, account, profile env, cwd). A different key closes
 * the old child first, which is what covers account/harness/cwd changes. */
export function persistentTransportFor(sessionId: string, transport: HarnessTurnTransport, key: string): PersistentTransport {
  const existing = persistentTransports.get(sessionId);
  if (existing && existing.key === key && existing.transport === transport) return existing;
  if (existing) void closePersistentTransport(sessionId);
  const created: PersistentTransport = {
    key, transport, session: transport === 'codex-app-server' ? TRANSPORT_SESSIONS.codex() : TRANSPORT_SESSIONS.acp(),
  };
  persistentTransports.set(sessionId, created);
  return created;
}

export async function closePersistentTransport(sessionId?: string): Promise<void> {
  const ids = sessionId === undefined ? [...persistentTransports.keys()] : [sessionId];
  await Promise.all(ids.map(async (id) => {
    const live = persistentTransports.get(id);
    if (!live) return;
    persistentTransports.delete(id);
    await live.session.close().catch(() => undefined);
  }));
}

/** Profile isolation plus, for HOME-rooted profiles, the user's real git/npm/
 * gh/docker configuration so a turn can still commit, push and install. */
export function turnEnvironment(harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined): Record<string, string> {
  return homeRedirectEnvironment(harness, nativeProfileEnvironment(account?.nativeProfile), { home: homedir(), exists: existsSync });
}

/** Name a chat, once, from a title the model produced.
 *
 * Never from the first message: that is the start of a sentence, not a name.
 * A /rename is the user's and is left alone; everything else is provisional
 * until a real title arrives, and a turn that produces none simply leaves the
 * chat unnamed for the next turn to ask again. */
export async function nameSession(
  session: HarnessSession,
  sources: { title?: string; vendor?: () => Promise<string | undefined> },
): Promise<void> {
  if (session.nameSource === 'user' || session.name) return;
  const raw = sources.title ?? await sources.vendor?.().catch(() => undefined);
  const title = raw ? normalizeSessionTitle(raw) : undefined;
  if (!title) return;
  session.name = title;
  session.nameSource = 'provider';
}



export async function nextUsableFailoverAccount(
  state: HarnessState,
  current: AiHarnessAccount,
  matchesTransport: (candidate: AiHarnessAccount) => boolean,
  attempted: ReadonlySet<string>,
): Promise<AiHarnessAccount | undefined> {
  const candidates = state.accounts.filter((candidate) => candidate.id !== current.id && !attempted.has(candidate.id)
    && candidate.provider === current.provider && candidate.status === 'ready'
    && matchesTransport(candidate));
  const usable: Array<{ account: AiHarnessAccount; remaining?: number }> = [];
  for (const candidate of candidates) {
    // Native Codex/Claude profiles expose real usage windows. Do not launch a
    // doomed retry merely because the last turn has not yet marked the local
    // account record exhausted. Providers without a probe stay eligible and
    // are classified reactively if their turn rejects for quota.
    const usage = await accountUsageLabel(candidate, state);
    if (usageLabelIsExhausted(usage)) {
      candidate.quotaState = 'exhausted';
      candidate.quotaRetryAt = undefined;
      continue;
    }
    const remaining = usageLabelRemainingPercent(usage);
    if (remaining !== undefined) candidate.quotaState = 'available';
    else if (candidate.quotaState === 'exhausted') continue;
    usable.push({ account: candidate, ...(remaining === undefined ? {} : { remaining }) });
  }
  // Prefer measured headroom. Unknown providers remain valid fallbacks, but
  // never outrank an account whose usage probe confirms capacity.
  return usable.sort((left, right) => (right.remaining ?? Number.NEGATIVE_INFINITY) - (left.remaining ?? Number.NEGATIVE_INFINITY))[0]?.account;
}



/** Create a portable child branch. The source keeps its provider-owned
 * identity; the child carries the ClikCode-owned transcript into its target. */
export function createHandoffBranch(input: {
  source: HarnessSession;
  target: AiLocalHarnessDefinition;
  accountId: string | null;
  model: string | null;
  defaults: HarnessDefaultSettings;
  now: string;
  id?: string;
  sourceDisplayName?: string;
}): HarnessSession {
  const sourceCommand = input.source.nativeHarness ?? input.source.route;
  const id = input.id ?? randomUUID();
  const base = input.source.name?.replace(/\s+\(from [^)]+\)$/i, '').trim();
  return {
    id, conversationId: conversationIdFor(input.source), parentSessionId: input.source.id,
    handoff: { fromSessionId: input.source.id, fromHarness: sourceCommand, at: input.now },
    route: 'local', accountId: input.accountId, provider: input.target.provider, model: input.model,
    effort: input.defaults.effort, permissionMode: input.defaults.permissionMode, accountFailover: input.defaults.accountFailover,
    workspace: input.source.workspace ?? process.cwd(), nativeHarness: input.target.command,
    ...(base ? { name: base } : {}),
    ...(sessionTranscriptMessages(input.source).length
      ? { messages: sessionTranscriptMessages(input.source).map((message) => ({ ...message })) }
      : {}),
    createdAt: input.now, updatedAt: input.now, status: 'active',
  };
}


function interruptedTurnMessages(
  messages: NonNullable<HarnessSession['messages']>, prompt: string, partialResponse: string, outputStarted: boolean,
): NonNullable<HarnessSession['messages']> {
  if (!outputStarted) return messages;
  const next = [...messages, { role: 'user' as const, content: prompt }];
  if (partialResponse) next.push({ role: 'assistant', content: partialResponse });
  return next;
}

export async function preserveInterruptedTurn(id: string, prompt: string, partialResponse: string, outputStarted: boolean): Promise<void> {
  if (!outputStarted) return;
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  if (session.pendingTurn?.prompt === prompt) {
    if (partialResponse) updatePendingResponse(session, partialResponse, 'replace', new Date().toISOString());
    finishPendingTurn(session, partialResponse || undefined, new Date().toISOString());
  } else session.messages = interruptedTurnMessages(session.messages ?? [], prompt, partialResponse, outputStarted);
  session.attachments = [];
  session.updatedAt = new Date().toISOString();
  await writeState(state);
}

export async function discardInterruptedTurn(id: string, prompt: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session || !discardPendingTurn(session, prompt)) return;
  session.updatedAt = new Date().toISOString();
  await writeState(state);
}

/** Serializes bounded checkpoint writes for one in-flight turn. Deltas update
 * memory immediately and coalesce into a disk write, while start, provider
 * identity changes, completion, and error unwinding force a durable flush. */
export class DurableTurnCheckpoint {
  private timer: NodeJS.Timeout | undefined;
  private writes: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(private readonly state: HarnessState, readonly session: HarnessSession) {}

  static async start(
    state: HarnessState, session: HarnessSession, prompt: string, queuedTurnId?: string,
  ): Promise<DurableTurnCheckpoint> {
    const checkpoint = new DurableTurnCheckpoint(state, session);
    if (queuedTurnId) consumeSessionTurn(session, queuedTurnId);
    beginPendingTurn(session, prompt, new Date().toISOString());
    await checkpoint.enqueue();
    return checkpoint;
  }

  response(text: string, mode: 'append' | 'replace' = 'append'): void {
    updatePendingResponse(this.session, text, mode, new Date().toISOString());
    this.schedule();
  }

  activity(event: HarnessActivityEvent): void {
    recordPendingActivity(this.session, event, new Date().toISOString());
    this.schedule();
  }

  async queue(submission: LiveTurnSubmission): Promise<void> {
    enqueueSessionTurn(this.session, submission, new Date().toISOString());
    try {
      await this.persistNow();
    } catch (error) {
      // Queued in memory and then failed to write is the one outcome the
      // composer cannot represent: this call rejecting hands the text back to
      // the draft, while the entry a later flush persists runs the turn
      // anyway -- the message both came back and was sent. Take it out again
      // so the rejection is the truth.
      consumeSessionTurn(this.session, submission.id);
      throw error;
    }
  }

  /** A steer that timed out was queued, then turned out to have landed after
   * all: drop the queued copy so it is not also sent as the next turn. */
  async unqueue(submission: LiveTurnSubmission): Promise<void> {
    if (consumeSessionTurn(this.session, submission.id)) await this.persistNow();
  }

  async steer(submission: LiveTurnSubmission): Promise<void> {
    recordPendingSteer(
      this.session, submission.text, submission.submittedAt,
      this.session.pendingTurn?.response?.length ?? 0, new Date().toISOString(),
    );
    await this.persistNow();
  }

  async persistNow(): Promise<void> {
    this.dirty = true;
    await this.flush();
  }

  async complete(response: string): Promise<void> {
    finishPendingTurn(this.session, response, new Date().toISOString());
    this.dirty = true;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dirty) {
      this.dirty = false;
      await this.enqueue();
    } else await this.writes;
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      void this.enqueue();
    }, 250);
  }

  private enqueue(): Promise<void> {
    this.writes = this.writes.then(() => writeState(this.state));
    return this.writes;
  }
}

/** Pull turns added directly in a vendor CLI back into an already-linked
 * ClikCode conversation. The native CLI remains the only writer of its own
 * files; this only reconciles ClikCode's cached view after an exact-id resume. */
export async function synchronizeNativeTranscript(state: HarnessState, session: HarnessSession): Promise<boolean> {
  if (!session.nativeHarness || !session.nativeSessionId) return false;
  const harness = localHarnessForCommand(session.nativeHarness);
  const reader = harness ? ADOPTED_TRANSCRIPT_READERS[harness.command] : undefined;
  if (!harness || !reader) return false;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const source = await reader(
    harness, session.nativeSessionId, session.workspace ?? process.cwd(), nativeProfileEnvironment(account?.nativeProfile),
  ).catch(() => []);
  const previousLength = (session.messages ?? []).length;
  const merged = mergeNativeTranscript(session.messages ?? [], source);
  if (merged.length === (session.messages ?? []).length) return false;
  session.messages = merged;
  // If the vendor transcript now contains the prompt that was journaled by a
  // previously interrupted ClikCode process, the vendor copy is authoritative
  // and the separate checkpoint must not render or hand off a duplicate.
  if (session.pendingTurn) {
    const appended = merged.slice(previousLength);
    const promptIndex = appended.findIndex((message) =>
      message.role === 'user' && message.content.trim() === session.pendingTurn!.prompt.trim());
    if (promptIndex >= 0) {
      const nativeHasAnswer = appended.slice(promptIndex + 1).some((message) => message.role === 'assistant');
      if (!nativeHasAnswer) {
        const checkpointAnswer = sessionTranscriptMessages({ ...session, messages: [] })
          .find((message) => message.role === 'assistant');
        if (checkpointAnswer) session.messages.push(checkpointAnswer);
      }
      delete session.pendingTurn;
    }
  }
  session.updatedAt = new Date().toISOString();
  return true;
}

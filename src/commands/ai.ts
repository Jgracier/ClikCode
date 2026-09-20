/** Local ClikDeploy AI harness lifecycle, account aliases, and durable session settings. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import type Conf from 'conf';
import chalk from 'chalk';
import { getApiKeyForUrl, getApiUrl } from './gateway-credentials.js';
import { gatewayLogin } from './gateway-login.js';
import { isAllowedLoopbackHost } from './control-api-host.js';
import { CLIKCODE_USER_AGENT, CLIKCODE_VERSION } from '../version.js';
import {
  gatewayHarnessFallbackNotice, gatewayHarnessUnavailable, runGatewayHarnessSessionTurn,
} from './ai-gateway-harness.js';
import { commonControlFor, optionIdsForControl, vendorFacingOptions } from './harness-options.js';
import { emitJson } from '../utils/structured-output.js';
import { isJsonDefaultMode } from '../utils/output-mode.js';
import { captureNativeHarness, captureNativeHarnessOutput, captureNativeHarnessTurn, createTurnIdleController, ensureNativeHarness, noteTurnActivityEvent, inspectNativeHarness, inspectNativeHarnessForPicker, loginNativeHarness, runNativeHarnessCommand } from './native-harness.js';
import { spawnPortable as spawn } from './spawn-portable.js';
import { classifyAccountFailure, failoverPrompt, interruptedTurnFailoverPrompt, replayIsSafe, usageLabelIsExhausted, usageLabelRemainingPercent } from './ai-failover.js';
import {
  ADOPTED_TRANSCRIPT_READERS, conversationTitle, discoverNativeSessions, FS_SESSION_DISCOVERY, mergeNativeTranscript, type DiscoveredNativeSession,
} from './native-session-discovery.js';
import type {
  AiHarnessAccount, AiHarnessOptionDefinition,
  AiHarnessPermissionMode, AiHarnessRoute, AiLocalHarnessDefinition,
  HarnessActivityEvent, HarnessDefaultSettings, HarnessPrompter, HarnessSession,
  HarnessState, PickerOption,
} from './types.js';
import {
  harnessIntegrationLevel, harnessSupportsEffort, harnessSupportsImages, harnessSupportsPermissionMode,
  localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider,
  nativeTurnResult, nativeTurnUsage, type NativeTurnResult,
  compactPath, nativeProfileEnvironment, renderActivityLine, sessionProviderLabel, streamLocalAiTurn,
} from './native-harness-protocol.js';
import {
  accountView, deviceManifest, harnessCommand, harnessStatePath, readState, resolveDefaultSettings, writeState,
} from './harness-state.js';
import {
  accountUsageLabel, cachedAccountUsageLabel, nativeModelCatalog, nativeModelCatalogForPicker, nativeModelLabel,
  nativeUsageReading, usageResetLabel, codexRateLimitsReading, recordDerivedUsage, recordNativeStreamUsage,
} from './native-account-data.js';
import {
  aiAccountAdd, aiAccountLogin, aiAccountLogout, aiAccountProviders, aiAccountRemove, aiAccountsList,
  aiAccountStatus, aiDoctor, announceBareInteractiveLogin, deriveAccountLabel, harnessNeedsLogin, syncAccountIdentityAfterLogin,
  setEmitHarnessOutput,
} from './account-management.js';
import { TerminalHarnessPrompter, terminalUiSupported } from './terminal-ui.js';
import { createCodexSession, runCodexAppServerTurn, type CodexAppServerTurnInput, type CodexSession } from './codex-app-server.js';
import { createAcpSession, runAcpTurn, type AcpAvailableCommand, type AcpSession, type AcpTurnInput } from './acp-client.js';
import { harnessTurnTransport, type HarnessTurnTransport } from './harness-transport.js';
import {
  allLocalHarnesses, harnessAcpLaunch, harnessCanRunTurns, harnessTierRank, homeRedirectEnvironment, maxPromptArgvBytes,
  nativeHarnessTurnArgv, promptExceedsArgvLimit,
} from './harness-runtime.js';
import { parseHarnessLine } from './harness-event-adapters.js';
import { appServerThreadOverrides, declaredOptionArgv, normalizeTurnUsage, type NormalizedTurnUsage } from './transport-options.js';
import { existsSync } from 'node:fs';
import {
  routeSlashInput, slashControls, slashHelpText, slashPalette, unknownSlashMessage,
  type SlashExtras, type SlashHandlerKey, type SlashRouteContext,
} from './slash-registry.js';
import { customCommandPrompt, discoverCustomCommands, type CustomCommand } from './custom-commands.js';
import { LiveTurnInputBroker, type LiveTurnSubmission } from './live-turn-input.js';
import {
  beginPendingTurn, consumeSessionTurn, discardPendingTurn, enqueueSessionTurn, finishPendingTurn, recordPendingActivity, recordPendingSteer,
  sessionTranscriptMessages, updatePendingResponse,
} from './turn-checkpoint.js';
export {
  aiAccountAdd, aiAccountLogin, aiAccountLogout, aiAccountProviders, aiAccountRemove, aiAccountsList,
  aiAccountStatus, aiDoctor,
};


let activeTerminalHarness: TerminalHarnessPrompter | undefined;

interface TurnRunOptions {
  liveInput?: LiveTurnInputBroker;
  queuedTurnId?: string;
  /** The interactive loop keeps ONE app-server / ACP child per open session
   * and closes it itself; headless sends stay one-shot. */
  persistentTransports?: boolean;
}

/** Prompter methods the terminal UI is gaining; feature-detected, never assumed. */
interface OptionalTerminalMethods {
  setPlan?(entries: ReadonlyArray<{ content: string; status: string; priority?: string }>): void;
  setTurnUsage?(usage: NormalizedTurnUsage): void;
}
function optionalTerminal(): OptionalTerminalMethods | undefined {
  return activeTerminalHarness as unknown as OptionalTerminalMethods | undefined;
}

/** Harnesses whose `experimental` structured turn this process saw rejected;
 * later turns go straight to the catalog's proven `fallbackTurn`. */
const fallbackTurnHarnesses = new Set<string>();

/** ACP `available_commands_update`, per ClikCode session, for the slash registry. */
const nativeAvailableCommands = new Map<string, readonly AcpAvailableCommand[]>();
export function sessionNativeCommands(sessionId: string): readonly AcpAvailableCommand[] {
  return nativeAvailableCommands.get(sessionId) ?? [];
}

interface PersistentTransport { key: string; transport: HarnessTurnTransport; session: CodexSession | AcpSession }
const persistentTransports = new Map<string, PersistentTransport>();
/** Test seam: the transport session factories. */
export const TRANSPORT_SESSIONS = { codex: createCodexSession, acp: createAcpSession };

/** One live child per open ClikCode session, keyed by everything that makes a
 * child reusable (harness, account, profile env, cwd). A different key closes
 * the old child first, which is what covers account/harness/cwd changes. */
function persistentTransportFor(sessionId: string, transport: HarnessTurnTransport, key: string): PersistentTransport {
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
function turnEnvironment(harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined): Record<string, string> {
  return homeRedirectEnvironment(harness, nativeProfileEnvironment(account?.nativeProfile), { home: homedir(), exists: existsSync });
}

function conversationIdFor(session: HarnessSession): string {
  return session.conversationId ?? session.id;
}

function hasConversationContent(session: HarnessSession): boolean {
  return Boolean(session.nativeSessionId || session.pendingTurn || (session.messages ?? []).length > 0);
}

async function nextUsableFailoverAccount(
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

export function requiresProviderHandoff(session: HarnessSession, targetHarness: string): boolean {
  return hasConversationContent(session) && (session.route !== 'local' || session.nativeHarness !== targetHarness);
}

/** How long a claim survives without a heartbeat. Generous enough that a busy
 * turn never looks abandoned, short enough that a killed terminal frees its
 * conversation quickly. */
export const SESSION_CLAIM_TTL_MS = 90_000;

/** Is another terminal driving this conversation right now?
 *
 * A pid is only meaningful on the machine that recorded it, so a claim from a
 * different host is judged on its heartbeat alone. On this host a dead pid
 * releases the claim immediately, which is what makes a crashed terminal's
 * conversation available again without waiting out the TTL. */
export function sessionClaimIsLive(
  session: HarnessSession,
  now = Date.now(),
  host = hostname(),
  pidAlive: (pid: number) => boolean = livePid,
): boolean {
  const claim = session.claim;
  if (!claim) return false;
  if (now - Date.parse(claim.heartbeatAt) > SESSION_CLAIM_TTL_MS) return false;
  if (claim.host !== host) return true;
  if (claim.pid === process.pid) return false;
  return pidAlive(claim.pid);
}

function livePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function claimSession(session: HarnessSession, now = new Date().toISOString()): void {
  session.claim = {
    pid: process.pid, host: hostname(),
    startedAt: session.claim?.pid === process.pid ? session.claim.startedAt : now,
    heartbeatAt: now,
  };
}

/** Only the owner releases a claim, so a crash-recovered stale claim is never
 * cleared by a terminal that does not own the conversation. */
export function releaseSession(session: HarnessSession): void {
  if (session.claim?.pid === process.pid && session.claim.host === hostname()) delete session.claim;
}

/** Leaving the foreground application is not the same operation as closing a
 * conversation. Touch the current branch so it remains the default branch on
 * the next launch, without changing its provider-owned session identity. */
export function markSessionLeftOpen(session: HarnessSession, now: string): void {
  session.status = 'active';
  delete session.closedAt;
  session.updatedAt = now;
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

/** One row per ClikCode conversation. Provider-native hops stay available via
 * the row's Tab history instead of appearing as duplicate/fork rows. */
export function sessionPickerOptions(
  sessions: readonly HarnessSession[],
  currentId: string,
  providerLabel: (session: HarnessSession) => string = sessionProviderLabel,
): PickerOption<string>[] {
  const groups = new Map<string, HarnessSession[]>();
  for (const session of sessions) {
    const root = conversationIdFor(session);
    const group = groups.get(root) ?? [];
    group.push(session);
    groups.set(root, group);
  }
  const timestamp = (session: HarnessSession): number => {
    const value = Date.parse(session.updatedAt);
    return Number.isNaN(value) ? -Infinity : value;
  };
  const createdTimestamp = (session: HarnessSession): number => {
    const value = Date.parse(session.createdAt);
    return Number.isNaN(value) ? timestamp(session) : value;
  };
  const orderedGroups = [...groups.values()].sort((left, right) =>
    Math.max(...right.map(timestamp)) - Math.max(...left.map(timestamp)));

  return orderedGroups.map((group) => {
    const history = [...group].sort((left, right) => createdTimestamp(left) - createdTimestamp(right));
    const byId = new Map(history.map((session) => [session.id, session]));
    const depthFor = (session: HarnessSession): number => {
      let depth = 0;
      let parentId = session.parentSessionId;
      const seen = new Set<string>();
      while (parentId && byId.has(parentId) && !seen.has(parentId)) {
        seen.add(parentId);
        depth += 1;
        parentId = byId.get(parentId)?.parentSessionId;
      }
      return depth;
    };
    const active = group.filter((session) => session.status === 'active');
    const latest = [...(active.length ? active : group)].sort((left, right) => timestamp(right) - timestamp(left))[0]!;
    const title = latest.name?.replace(/\s+\(from [^)]+\)$/i, '').trim() || 'Untitled chat';
    const model = nativeModelLabel(latest.nativeHarness, latest.model);
    return {
      label: title,
      detail: `· ${providerLabel(latest)}${group.some((session) => session.id === currentId) ? ' · current' : ''} · ${model ?? 'automatic'} · ${new Date(latest.updatedAt).toLocaleString()}${history.length > 1 ? ` · Tab: ${history.length} history entries` : ''}`,
      value: latest.id,
      alternates: history.length > 1 ? history.map((session) => ({
        label: `${'  '.repeat(depthFor(session))}${providerLabel(session)} · ${!session.parentSessionId || !byId.has(session.parentSessionId) ? 'original' : session.handoff ? 'handed off' : 'fork'}${session.id === latest.id ? ' · latest' : ''} · ${new Date(session.updatedAt).toLocaleString()}`,
        value: session.id,
      })) : undefined,
    };
  });
}

export function interruptedTurnMessages(
  messages: NonNullable<HarnessSession['messages']>, prompt: string, partialResponse: string, outputStarted: boolean,
): NonNullable<HarnessSession['messages']> {
  if (!outputStarted) return messages;
  const next = [...messages, { role: 'user' as const, content: prompt }];
  if (partialResponse) next.push({ role: 'assistant', content: partialResponse });
  return next;
}

async function preserveInterruptedTurn(id: string, prompt: string, partialResponse: string, outputStarted: boolean): Promise<void> {
  if (!outputStarted) return;
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  if (session.pendingTurn?.prompt === prompt) {
    if (partialResponse) updatePendingResponse(session, partialResponse, 'replace', new Date().toISOString());
    finishPendingTurn(session, partialResponse || undefined, new Date().toISOString());
  } else session.messages = interruptedTurnMessages(session.messages ?? [], prompt, partialResponse, outputStarted);
  session.name ??= conversationTitle(prompt);
  session.attachments = [];
  session.updatedAt = new Date().toISOString();
  await writeState(state);
}

async function discardInterruptedTurn(id: string, prompt: string): Promise<void> {
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
    session.name ??= conversationTitle(prompt);
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
async function synchronizeNativeTranscript(state: HarnessState, session: HarnessSession): Promise<boolean> {
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
  const firstUserMessage = merged.find((message) => message.role === 'user')?.content;
  if (!session.name && firstUserMessage) session.name = conversationTitle(firstUserMessage);
  session.updatedAt = new Date().toISOString();
  return true;
}

/** Gateway routing owns these fields as one policy unit. Keeping the mutation
 * centralized prevents route switches, slash settings, and headless setters
 * from leaving stale local harness/account controls attached to a remote
 * platform-managed session. */
function applyGatewaySessionPolicy(session: HarnessSession): void {
  session.route = 'gateway';
  session.accountId = null;
  session.provider = 'clikdeploy-gateway';
  session.model = null;
  session.effort = 'platform-managed';
  session.accountFailover = 'never';
  session.gatewayConfirmed = true;
  delete session.permissionMode;
  delete session.nativeHarness;
  delete session.nativeSessionId;
  delete session.nativeStartedAt;
  delete session.harnessOptions;
}

function applyFreshLocalSessionPolicy(state: HarnessState, session: HarnessSession): void {
  const defaults = resolveDefaultSettings(state, null);
  session.route = 'local';
  session.accountId = null;
  session.provider = null;
  session.model = null;
  session.effort = defaults.effort;
  session.permissionMode = defaults.permissionMode;
  session.accountFailover = defaults.accountFailover;
  delete session.gatewayConfirmed;
  delete session.nativeHarness;
  delete session.nativeSessionId;
  delete session.nativeStartedAt;
  delete session.harnessOptions;
}

function line(label: string, value: unknown): string {
  return `  ${chalk.dim(label.padEnd(10))}${String(value ?? '—')}`;
}

function captureProcess(command: string, args: readonly string[], cwd?: string, stdinText?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { if (stdout.length < 1024 * 1024) stdout += chunk; });
    child.stderr!.on('data', (chunk: string) => { if (stderr.length < 16 * 1024) stderr += chunk; });
    if (stdinText !== undefined) child.stdin!.end(stdinText);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited ${code ?? 1}`)));
  });
}

/** OSC 52 asks the TERMINAL to set the clipboard, so it works over SSH where
 * no clipboard binary can reach the user's machine. tmux/screen need the
 * sequence wrapped in their passthrough envelope. */
export function osc52Sequence(text: string, environment: NodeJS.ProcessEnv = process.env): string {
  const payload = `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
  if (environment.TMUX) return `\u001bPtmux;${payload.replace(/\u001b/g, '\u001b\u001b')}\u001b\\`;
  if (/^screen/.test(environment.TERM ?? '')) return `\u001bP${payload}\u001b\\`;
  return payload;
}
const OSC52_MAX_BYTES = 74_000; // common terminal limit is ~100 kB of base64

async function copyToClipboard(text: string): Promise<'binary' | 'osc52'> {
  const candidates: Array<[string, string[]]> = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : process.platform === 'win32'
      ? [['clip', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  // Over SSH a local clipboard binary would fill the REMOTE machine's clipboard.
  const remote = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  let lastError: unknown;
  if (!remote) {
    for (const [command, args] of candidates) {
      try { await captureProcess(command, args, undefined, text); return 'binary'; } catch (error) { lastError = error; }
    }
  }
  if (output.isTTY && Buffer.byteLength(text, 'utf8') <= OSC52_MAX_BYTES) {
    output.write(osc52Sequence(text));
    return 'osc52';
  }
  throw new Error(`No supported clipboard command is available${output.isTTY ? ' and the response is too large for the terminal clipboard (OSC 52)' : ''}${lastError instanceof Error && lastError.message ? `: ${lastError.message}` : '.'}`);
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** Decode a path as entered or dragged into a terminal without invoking a
 * shell. Drag-and-drop commonly adds quotes or backslashes before spaces. */
export function decodeAttachmentPath(input: string): string {
  let value = input.trim();
  const quoted = value.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
  if (quoted) value = quoted[1] ?? quoted[2] ?? '';
  if (value.startsWith('file://')) {
    try { return fileURLToPath(value); } catch { return value; }
  }
  // Backslashes are path separators on Windows, but terminal escape
  // characters on the Unix platforms where drag-and-drop produces them.
  return process.platform === 'win32' ? value : value.replace(/\\(.)/g, '$1');
}

export function expandHomePath(value: string, home = homedir()): string {
  return value === '~' ? home : /^~[\\/]/.test(value) ? join(home, value.slice(2)) : value;
}

/** Resolve a standalone input only when it clearly looks like a file
 * reference and names an existing regular file. This preserves slash
 * commands while allowing absolute image paths such as /home/me/photo.png. */
export async function resolveStandaloneAttachment(
  input: string,
  workspace: string,
): Promise<string | undefined> {
  const raw = input.trim();
  const decoded = decodeAttachmentPath(raw);
  const explicitlyQuoted = /^(?:"[\s\S]*"|'[\s\S]*')$/.test(raw);
  const looksLikePath = raw.startsWith('file://')
    || isAbsolute(decoded)
    || decoded.startsWith('./')
    || decoded.startsWith('../')
    || decoded.startsWith('~/')
    || explicitlyQuoted
    || IMAGE_EXTENSIONS.has(extname(decoded).toLowerCase());
  if (!looksLikePath) return undefined;
  const expanded = expandHomePath(decoded);
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded);
  try {
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    // fail-open-ok: this decides whether typed text names an attachable file.
    // A path that cannot be stat'd is simply not one, and the text is then
    // treated as an ordinary prompt -- there is no failure to report.
    return undefined;
  }
}

async function queueAttachment(session: HarnessSession, path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Attachments must be files.');
  if (info.size > 1024 * 1024) throw new Error('Attachments are limited to 1 MiB each.');
  session.attachments = [...new Set([...(session.attachments ?? []), path])].slice(-10);
}

async function prepareAttachments(paths: readonly string[]): Promise<{ textContext: string; images: string[] }> {
  const blocks: string[] = [];
  const images: string[] = [];
  let total = 0;
  for (const path of paths) {
    if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) { images.push(path); continue; }
    const info = await stat(path);
    if (info.size > 256 * 1024 || total + info.size > 512 * 1024) throw new Error('Text attachments are limited to 256 KiB each and 512 KiB per request.');
    const content = await readFile(path, 'utf8');
    total += Buffer.byteLength(content);
    blocks.push(`\n<clikcode_attachment path="${path.replace(/"/g, '&quot;')}">\n${content}\n</clikcode_attachment>`);
  }
  return { textContext: blocks.join('\n'), images };
}

function renderSessionCard(session: HarnessSession, account?: string): string {
  const modelLabel = nativeModelLabel(session.nativeHarness, session.model);
  return [
    chalk.bold.cyan('ClikCode'),
    ...(session.name ? [line('chat', session.name)] : []),
    line('project', compactPath(session.workspace ?? process.cwd())),
    line('provider', sessionProviderLabel(session)),
    line('account', account ?? 'default'),
    line('model', modelLabel ?? 'provider default'),
    line('effort', session.route === 'gateway' ? 'platform managed' : session.effort),
    line('permissions', session.route === 'gateway' ? 'platform policy' : session.permissionMode ?? 'ask'),
    line('session', session.id.slice(0, 8)),
  ].join('\n');
}

async function acquireRuntimeLock(lockPath: string, runtimePath: string): Promise<FileHandle> {
  const attempt = () => open(lockPath, 'wx', 0o600);
  try {
    return await attempt();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as { pid?: unknown };
      if (typeof runtime.pid === 'number') {
        process.kill(runtime.pid, 0);
        throw new Error(`a ${harnessCommand()} control API is already running (pid ${runtime.pid})`);
      }
    } catch (runtimeError) {
      if (runtimeError instanceof Error && runtimeError.message.includes('control API is already running')) throw runtimeError;
      if ((runtimeError as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(`a ${harnessCommand()} control API appears to be running but its process cannot be inspected`);
      }
      // Missing/corrupt runtime metadata or ESRCH means the lock is stale.
    }
    await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    return attempt();
  }
}

/** Keep automation structured while making the foreground harness feel like a CLI, not an API dump. */
/** Panels emitted through the TUI; the loop pauses after a command that showed one. */
let panelsShown = 0;

function emitHarnessOutput(payload: Record<string, unknown>): void {
  if (isJsonDefaultMode()) return emitJson(payload);
  // In the TUI nothing may be written at the composer cursor: every human
  // rendering below goes through the prompter's panel instead of raw stdout.
  const write = (text: string): void => {
    if (!activeTerminalHarness) { output.write(text); return; }
    const [title = '', ...rest] = text.replace(/^\n+|\n+$/g, '').split('\n');
    activeTerminalHarness.panel(title.replace(/\u001b\[[0-9;]*m/g, '').trim(), rest.join('\n').replace(/^\n+/, ''));
    panelsShown += 1;
  };
  if (activeTerminalHarness) {
    // State-changing commands are reflected by the persistent status line. Raw
    // panels here would be written into the composer and corrupt the TUI.
    if (payload.panel === 'settings' && payload.session) {
      activeTerminalHarness.render(
        payload.session as HarnessSession,
        typeof payload.account === 'string' ? payload.account : undefined,
      );
      return;
    }
    if (payload.panel === 'provider-selected' || (payload.panel === 'accounts' && payload.selected) || payload.status === 'connected') return;
  }
  if (payload.status === 'ready') {
    const session = payload.session as HarnessSession;
    const account = typeof payload.account === 'string' ? payload.account : undefined;
    write(`\n${renderSessionCard(session, account)}\n\n${chalk.dim('Type your request, /provider to choose a provider, or /help for commands.')}\n\n`);
    return;
  }
  if (payload.panel === 'provider-selected' && typeof payload.harness === 'string') {
    const account = typeof payload.account === 'string' ? ` · ${payload.account}` : '';
    write(`\n${chalk.green('✓')} ${chalk.bold(payload.harness)} selected${chalk.dim(account)}\n\n`);
    return;
  }
  if (payload.panel === 'error' && typeof payload.message === 'string') {
    write(`\n${chalk.red('Error:')} ${payload.message}\n\n`);
    return;
  }
  if (payload.panel === 'help' && typeof payload.helpText === 'string') {
    write(`\n${chalk.bold('Commands')}\n\n${payload.helpText}\n\n`);
    return;
  }
  if (payload.panel === 'settings' && payload.session) {
    const session = payload.session as HarnessSession;
    const account = typeof payload.account === 'string' ? payload.account : undefined;
    write(`\n${chalk.bold('Current setup')}\n${renderSessionCard(session, account)}\n\n${chalk.dim('Change with /model, /effort, /provider, or /switch.')}\n\n`);
    return;
  }
  if (payload.panel === 'accounts' && Array.isArray(payload.accounts)) {
    const accounts = payload.accounts as Array<Record<string, unknown>>;
    write(`\n${chalk.bold('Accounts')}\n` + (accounts.length ? accounts.map((account) => {
      const selected = (payload.session as HarnessSession | undefined)?.accountId === account.id;
      return `  ${selected ? chalk.green('●') : chalk.dim('○')} ${account.label} ${chalk.dim(`(${account.provider} · ${account.status})`)}`;
    }).join('\n') : `  ${chalk.dim('No accounts yet.')}`) + `\n\n${chalk.dim('Use /account to choose, or /accounts login <provider> <label>.')}\n\n`);
    return;
  }
  if (payload.panel === 'accounts' && payload.selected && typeof payload.selected === 'object') {
    const selected = payload.selected as Record<string, unknown>;
    write(`\n${chalk.green('✓')} Account selected: ${chalk.bold(String(selected.label))} ${chalk.dim(`(${selected.provider})`)}\n\n`);
    return;
  }
  if (payload.panel === 'models' && Array.isArray(payload.models)) {
    const models = payload.models as Array<Record<string, unknown>>;
    write(`\n${chalk.bold('Models')}\n` + (models.length ? models.map((model) => `  ${model.model} ${chalk.dim(`(${model.provider ?? model.account})`)}`).join('\n') : `  ${chalk.dim('Using the provider default. Set one with /model <name>.')}`) + '\n\n');
    return;
  }
  if (payload.panel === 'sessions' && Array.isArray(payload.sessions)) {
    const sessions = payload.sessions as Array<Record<string, unknown>>;
    write(`\n${chalk.bold('Sessions')}\n` + (sessions.length ? sessions.map((item) => `  ${String(item.id).slice(0, 8)}  ${item.harness ?? item.provider ?? 'unselected'}  ${chalk.dim(String(item.status))}`).join('\n') : `  ${chalk.dim('No saved sessions.')}`) + '\n\n');
    return;
  }
  if (payload.panel === 'conversation-reset') {
    write(`\n${chalk.green('✓')} New conversation started\n\n`);
    return;
  }
  if (payload.panel === 'history' && Array.isArray(payload.messages)) {
    const messages = payload.messages as Array<{ role: string; content: string }>;
    write(`\n${chalk.bold('Conversation')}\n\n` + (messages.length
      ? messages.map((message) => `${message.role === 'assistant' ? chalk.cyan('assistant') : chalk.green('you')}\n${message.content}`).join('\n\n')
      : chalk.dim('No messages yet.')) + '\n\n');
    return;
  }
  if (payload.panel === 'diff' && typeof payload.diff === 'string') {
    write(`\n${chalk.bold('Project changes')}\n\n${payload.diff || chalk.dim('Working tree is clean.')}\n\n`);
    return;
  }
  if (payload.panel === 'attachments' && Array.isArray(payload.attachments)) {
    const attachments = payload.attachments as string[];
    write(`\n${chalk.bold('Next-request attachments')}\n` + (attachments.length
      ? attachments.map((path) => `  ${chalk.cyan('•')} ${compactPath(path)}`).join('\n')
      : `  ${chalk.dim('None queued.')}`) + '\n\n');
    return;
  }
  if (payload.panel === 'usage' && payload.totals && typeof payload.totals === 'object') {
    const totals = payload.totals as Record<string, unknown>;
    write(`\n${chalk.bold('Usage')}\n${line('calls', totals.calls)}\n${line('input', `${totals.inputTokens ?? 0} tokens`)}\n${line('output', `${totals.outputTokens ?? 0} tokens`)}\n\n`);
    return;
  }
  if (payload.panel === 'session-closed') {
    write(`\n${chalk.dim('Session saved. See you next time.')}\n\n`);
    return;
  }
  if (typeof payload.text === 'string') {
    write(`\n${payload.text}\n\n`);
    return;
  }
  if (typeof payload.panel === 'string') {
    const controls = Array.isArray(payload.controls) ? payload.controls.join(' · ') : '';
    const title = payload.panel.replace(/-/g, ' ').replace(/^./, (value) => value.toUpperCase());
    write(`\n${chalk.bold(title)}${controls ? `\n  ${chalk.dim(controls)}` : ''}\n\n`);
    return;
  }
  if (activeTerminalHarness) return write(`\n${JSON.stringify(payload, null, 2)}\n`);
  emitJson(payload);
}
setEmitHarnessOutput(emitHarnessOutput);

function sendJson(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function boundPort(server: Server): number {
  const address = server.address();
  return address && typeof address !== 'string' ? address.port : -1;
}

function methodAndPath(request: IncomingMessage): `${string} ${string}` {
  return `${request.method ?? 'GET'} ${new URL(request.url ?? '/', 'http://127.0.0.1').pathname}`;
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(value.slice('Bearer '.length));
  const secret = Buffer.from(expected);
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1_000_000) throw new Error('request body too large');
  }
  return JSON.parse(body);
}

function localApiKey(account: AiHarnessAccount): string {
  if (account.authKind !== 'api-key' || !account.credentialRef.startsWith('env:')) {
    throw new Error('this account needs a supported local API-key resolver (env:NAME)');
  }
  const name = account.credentialRef.slice(4);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('invalid local environment credential reference');
  const value = process.env[name];
  if (!value) throw new Error(`local credential ${name} is not available in this harness process`);
  return value;
}


/** Starts an intentionally loopback-only harness service. It exposes no provider tokens. */
export async function aiStart(_config: Conf, options: { port?: string }): Promise<void> {
  // The control API is optional. When no port is requested, defer entirely to
  // the OS so ClikCode never competes with ClikDeploy or another local tool.
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer from 0 to 65535');
  const runtimeDirectory = join(harnessStatePath(), '..');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const runtimePath = join(runtimeDirectory, 'runtime.json');
  const lockPath = join(runtimeDirectory, 'runtime.lock');
  const runtimeLock = await acquireRuntimeLock(lockPath, runtimePath);
  const startupState = await readState();
  const server = createServer(async (request, response) => {
    try {
      // DNS-rebinding guard: only a literal loopback authority on OUR port.
      if (!isAllowedLoopbackHost(request.headers.host, boundPort(server))) return sendJson(response, 403, { error: 'forbidden_host' });
      const route = methodAndPath(request);
      if (route === 'GET /v1/health') {
        sendJson(response, 200, { status: 'ok', installationId: startupState.installationId, runtime: harnessCommand(), credentialBoundary: 'local-only' });
      } else if (!authorized(request, startupState.localApiToken)) {
        sendJson(response, 401, { error: 'unauthorized' });
      } else {
        // Commands and native harnesses may update state while the optional
        // control API is running. Always serve the latest atomic snapshot.
        const state = await readState();
        if (route === 'GET /v1/accounts') {
        sendJson(response, 200, { accounts: state.accounts.map(accountView) });
        } else if (route === 'GET /v1/device') {
        sendJson(response, 200, { device: deviceManifest(state) });
        } else if (route === 'GET /v1/models') {
        sendJson(response, 200, {
          models: state.accounts.flatMap((account) => account.models.map((model) => ({ accountId: account.id, provider: account.provider, model }))),
        });
        } else if (route === 'GET /v1/sessions') {
        sendJson(response, 200, { sessions: state.sessions });
        } else if (route === 'GET /v1/usage') {
        sendJson(response, 200, { invocations: state.invocations });
        } else if (route === 'POST /v1/chat') {
        const body = await readJson(request) as { accountId?: unknown; messages?: unknown; effort?: unknown };
        const account = state.accounts.find((item) => item.id === body.accountId);
        if (!account) throw new Error('local account not found');
        if (!Array.isArray(body.messages) || !body.messages.every((m) => typeof m === 'object' && m !== null && ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant') && typeof (m as { content?: unknown }).content === 'string')) {
          throw new Error('messages must be user/assistant text messages');
        }
        const model = account.models[0];
        if (!model) throw new Error('local account has no configured model');
        const startedAt = Date.now();
        const turn = await streamLocalAiTurn({ provider: account.provider, model, apiKey: localApiKey(account), credentialSource: 'env', messages: body.messages as Array<{ role: 'user' | 'assistant'; content: string }>, ...(typeof body.effort === 'string' ? { reasoningEffort: body.effort as never } : {}) });
        const invocation = { id: randomUUID(), accountId: account.id, provider: account.provider, model, at: new Date().toISOString(), inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, latencyMs: Date.now() - startedAt };
        // The turn above can run for minutes, and the interactive CLI writes
        // real conversation state throughout. `state` is the pre-turn snapshot
        // of the WHOLE file, so persisting it here would revert every message,
        // rename, and new conversation written meanwhile. Re-read so appending
        // one usage record only ever appends.
        const latest = await readState();
        latest.invocations.push(invocation);
        await writeState(latest);
        sendJson(response, 200, { text: turn.text, toolCalls: turn.toolCalls, usage: turn.usage, invocation });
        } else {
          sendJson(response, 404, { error: 'not_found' });
        }
      }
    } catch {
      sendJson(response, 500, { error: 'harness_error' });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local control API did not expose a TCP address');
    await writeFile(runtimePath, `${JSON.stringify({ pid: process.pid, port: address.port, host: '127.0.0.1', installationId: startupState.installationId, startedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    emitJson({ status: 'running', url: `http://127.0.0.1:${address.port}`, installationId: startupState.installationId, credentialBoundary: 'local-only' });
    await new Promise<void>((resolve) => {
      const stop = () => server.close(() => resolve());
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    await runtimeLock.close().catch(() => undefined);
    await unlink(runtimePath).catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function aiStatus(): Promise<void> {
  const runtimePath = join(harnessStatePath(), '..', 'runtime.json');
  try {
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as { pid?: unknown; port?: unknown; host?: unknown; installationId?: unknown; startedAt?: unknown };
    let running = false;
    if (typeof runtime.pid === 'number') {
      try { process.kill(runtime.pid, 0); running = true; } catch (error) { running = (error as NodeJS.ErrnoException).code === 'EPERM'; }
    }
    emitJson({ status: running ? 'running' : 'stale', ...runtime, credentialBoundary: 'local-only' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    emitJson({ status: 'stopped' });
  }
}

export async function aiStop(): Promise<void> {
  const runtimePath = join(harnessStatePath(), '..', 'runtime.json');
  const state = await readState();
  let runtime: { pid?: unknown; installationId?: unknown };
  try {
    runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as typeof runtime;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emitJson({ status: 'stopped' });
    throw error;
  }
  if (runtime.installationId !== state.installationId || typeof runtime.pid !== 'number') {
    throw new Error('refusing to stop a runtime record that does not belong to this ClikCode installation');
  }
  try { process.kill(runtime.pid, 'SIGTERM'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  emitJson({ status: 'stopping', pid: runtime.pid });
}

/** Select a provider while retaining ClikCode as the foreground UI. Installs
 * it first if needed, and — only inside the interactive terminal session,
 * where suspending the alt-screen for a vendor login prompt makes sense —
 * signs in if the vendor CLI reports (or a fresh install implies) that it
 * isn't authenticated yet. The goal: every harness either works immediately
 * or ClikCode gets you to "working" itself, instead of erroring and telling
 * you to go run something separately. */
export async function aiHarnessSelect(harnessCommandName: string, sessionId: string): Promise<void> {
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  if (harness.surface !== 'terminal') throw new Error(`${harness.displayName} is editor-only and cannot run turns inside ClikCode.`);
  if (!harnessCanRunTurns(harness)) throw new Error(`${harness.displayName} does not publish a non-interactive turn contract (CLI or ACP) required by the centralized ClikCode UI.`);
  const freshInstall = !(await inspectNativeHarness(harness)).installed;
  if (freshInstall) {
    activeTerminalHarness?.startWaiting(`installing ${harness.displayName}…`);
    try { await ensureNativeHarness(harness); } finally { activeTerminalHarness?.stopWaiting(); }
  }
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`AI session "${sessionId}" was not found`);
  const sameHarness = session.nativeHarness === harness.command;
  if (!sameHarness) {
    if (requiresProviderHandoff(session, harness.command)) {
      throw new Error(`Use /${harness.command} to hand off this ${sessionProviderLabel(session)} conversation. Native provider changes always create a new branch.`);
    }
    session.nativeSessionId = undefined;
    session.nativeStartedAt = undefined;
    session.model = null;
  }
  session.nativeHarness = harness.command;
  session.provider = harness.provider;
  session.route = 'local';
  session.workspace ??= process.cwd();
  const selected = session.accountId ? state.accounts.find((account) => account.id === session.accountId) : undefined;
  // Tracks whether the account below is being minted right now, not found
  // pre-existing -- needed because harnessNeedsLogin returns false
  // unconditionally for any harness with no statusArgv (Gemini, Antigravity,
  // Amp: nothing to scriptably ask "are you logged in?" at all), so a
  // brand-new placeholder account for one of those would otherwise be
  // marked 'ready' and never get a single chance at the login/suspend
  // handoff -- the real mechanism behind "Antigravity CLI does not publish
  // an isolated configuration-root contract" surfacing at /add-account
  // time instead: the placeholder had already silently claimed the one
  // available account slot for a harness with no profileEnv, with the user
  // never having had a real opportunity to authenticate it in the first
  // place.
  let accountJustCreated = false;
  if (!selected || selected.provider !== harness.provider || selected.status !== 'ready') {
    const accounts = state.accounts.filter((account) => account.provider === harness.provider && account.authKind === 'vendor-cli' && account.status === 'ready');
    if (accounts.length === 1) session.accountId = accounts[0].id;
    else if (accounts.length === 0) {
      accountJustCreated = true;
      // Same derivation addAccountForHarness uses after an explicit login,
      // applied here too so a session's very first auto-created account
      // shows a real identity from the start instead of the generic "X
      // default" placeholder this used unconditionally before -- which is
      // exactly what was confusing about accounts named "Claude Code
      // default"/"Codex default" etc. undefined profilePath is correct
      // here: this is always the harness's one default, unisolated profile,
      // never one under an isolated CLAUDE_CONFIG_DIR-style directory.
      // Falls back to the placeholder if derivation finds nothing (most
      // harnesses currently), AND if the derived label would collide with
      // an account that already exists under a different provider (the
      // same real person's email showing up on two harnesses is entirely
      // possible and not a bug) -- labels must stay globally unique, and
      // the safe "X default" naming always is, by construction.
      const derived = await deriveAccountLabel(harness, undefined);
      const label = derived && !state.accounts.some((item) => item.label.toLowerCase() === derived.toLowerCase())
        ? derived : `${harness.displayName} default`;
      const account: AiHarnessAccount = {
        id: randomUUID(), provider: harness.provider, label, authKind: 'vendor-cli',
        models: [], status: 'ready', credentialRef: `native:${harness.binary}:default`,
      };
      state.accounts.push(account);
      session.accountId = account.id;
    } else session.accountId = null;
  }
  let account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  if (activeTerminalHarness && harness.loginArgv) {
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    if (freshInstall || (accountJustCreated && !harness.statusArgv) || await harnessNeedsLogin(harness, environment)) {
      if (harness.loginCapturable) {
        activeTerminalHarness.startWaiting(`signing in to ${harness.displayName}…`);
        try { await loginNativeHarness(harness, environment); } finally { activeTerminalHarness.stopWaiting(); }
      } else {
        activeTerminalHarness.activity(`${chalk.yellow('signing in to')} ${chalk.dim(harness.displayName)}`);
        await activeTerminalHarness.suspend();
        try {
          announceBareInteractiveLogin(harness);
          await loginNativeHarness(harness, environment);
        } finally {
          activeTerminalHarness.resume();
        }
      }
      // Same identity check /account's "add another account" flow uses --
      // a plain /provider login deserves the real dedup-by-identity logic,
      // not a weaker "only rename if it still looks like a placeholder"
      // check that misses re-authenticating as a genuinely different real
      // account entirely.
      if (account) {
        account = await syncAccountIdentityAfterLogin(harness, account, state);
        session.accountId = account.id;
      }
    }
  }
  if (!session.model) {
    const catalog = await nativeModelCatalog(harness, account);
    if (catalog.configured) session.model = catalog.configured;
  }
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  const compatible = state.accounts.filter((account) => account.provider === harness.provider && account.status === 'ready');
  emitHarnessOutput({
    panel: 'provider-selected', harness: harness.command, displayName: harness.displayName, provider: harness.provider,
    account: state.accounts.find((account) => account.id === session.accountId)?.label ?? null,
    model: session.model ?? 'provider default', centralized: true,
    ...(session.accountId ? {} : { actionRequired: `Choose one with /accounts use <label>`, accounts: compatible.map(accountView) }),
  });
}

export async function aiModelsList(): Promise<void> {
  const state = await readState();
  emitJson({
    models: state.accounts.flatMap((account) => account.models.map((model) => ({
      accountId: account.id,
      account: account.label,
      provider: account.provider,
      model,
      status: account.status,
    }))),
  });
}

export async function aiUsage(): Promise<void> {
  const state = await readState();
  const totals = state.invocations.reduce(
    (sum, invocation) => ({
      calls: sum.calls + 1,
      inputTokens: sum.inputTokens + (invocation.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (invocation.outputTokens ?? 0),
      latencyMs: sum.latencyMs + invocation.latencyMs,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 },
  );
  emitJson({ ...totals, avgLatencyMs: totals.calls ? Math.round(totals.latencyMs / totals.calls) : 0, invocations: state.invocations });
}

/** Reports the separate ClikDeploy OAuth/API-key gateway identity, never a BYO provider login. */
export async function aiGatewayStatus(config: Conf): Promise<void> {
  const apiUrl = getApiUrl(config);
  emitJson({
    route: 'gateway',
    connected: Boolean(getApiKeyForUrl(config, apiUrl)),
    apiUrl,
    authentication: 'clikdeploy-oauth-or-api-key',
    credentialBoundary: 'gateway-auth-only',
    hint: `Run \`${harnessCommand()} gateway login\` to connect ClikDeploy Gateway, or use \`${harnessCommand()} accounts add\` for a provider login that stays local.`,
  });
}

const VALID_EFFORTS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const VALID_PERMISSION_MODES: readonly AiHarnessPermissionMode[] = ['ask', 'bypass', 'auto'];

/** An option by id, falling back to the other spellings of whatever control
 * owns that id. `--add-dir` and `--include-directories` are one concept, so
 * asking any harness for `add-dir` must find the one it actually publishes --
 * looking up the literal id is what made /add-dir refuse on Gemini and Qwen. */
function optionForHarness(harness: AiLocalHarnessDefinition, id: string): AiHarnessOptionDefinition | undefined {
  const options = localHarnessCapabilityManifest(harness).options;
  const exact = options.find((option) => option.id === id);
  if (exact) return exact;
  const control = commonControlFor(id);
  if (!control) return undefined;
  const ids = optionIdsForControl(control);
  return options.find((option) => ids.includes(option.id));
}

/** The option a ClikCode command drives on THIS harness, whatever the vendor
 * spells it. */
function optionForControl(
  harness: AiLocalHarnessDefinition, control: string,
): AiHarnessOptionDefinition | undefined {
  const ids = optionIdsForControl(control);
  return localHarnessCapabilityManifest(harness).options.find((option) => ids.includes(option.id));
}

function parseHarnessOption(option: AiHarnessOptionDefinition, raw: string): unknown {
  const value = raw.trim();
  if (option.kind === 'boolean') {
    if (['true', 'on', 'yes', '1', 'enabled'].includes(value.toLowerCase())) return true;
    if (['false', 'off', 'no', '0', 'disabled'].includes(value.toLowerCase())) return false;
    throw new Error(`${option.label} must be on or off`);
  }
  if (option.kind === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${option.label} must be a non-negative number`);
    return parsed;
  }
  if (option.kind === 'string-list' || option.kind === 'path-list') {
    const values = value.split(',').map((item) => item.trim()).filter(Boolean);
    if (!values.length) throw new Error(`${option.label} requires at least one value`);
    return values;
  }
  if (option.values?.length && !option.values.includes(value)) throw new Error(`${option.label} must be one of ${option.values.join(', ')}`);
  if (!value) throw new Error(`${option.label} cannot be empty`);
  return value;
}

function setSessionHarnessOption(session: HarnessSession, harness: AiLocalHarnessDefinition, id: string, raw: string): void {
  const option = optionForHarness(harness, id);
  if (!option) throw new Error(`${harness.displayName} does not support option "${id}"`);
  const parsed = parseHarnessOption(option, raw);
  // Keyed by the option the harness actually publishes, never by the id the
  // caller asked for: a value stored under `add-dir` on a harness that spells
  // it `include-directories` is a value no turn ever reads.
  if (option.id === 'model') session.model = String(parsed);
  else if (option.id === 'effort') session.effort = String(parsed);
  else if (option.id === 'workspace') session.workspace = String(parsed);
  else if (option.id === 'permissions') session.permissionMode = String(parsed) as AiHarnessPermissionMode;
  else session.harnessOptions = { ...(session.harnessOptions ?? {}), [option.id]: parsed };
  if (option.requiresNewSession) {
    session.nativeSessionId = undefined;
    session.nativeStartedAt = undefined;
  }
}

function normalizeFailoverWord(value: string): 'never' | 'on-quota-exhausted' {
  if (value === 'auto') return 'on-quota-exhausted';
  if (value === 'never') return 'never';
  throw new Error('failover must be auto or never');
}

/** Both `/settings global <key> <value>` and `/settings provider <id> <key> <value>`
 * write into the same three fields; this is the one place that validates a value
 * for a given key so the two entry points can't drift out of sync.
 *
 * `harness`, when given (the provider-scoped path only — a global default has
 * no single harness to check against), gates effort and permission mode on
 * what the catalog actually declares that vendor CLI supports. Without this,
 * a provider override could be accepted and then silently do nothing: the
 * turn-argv builder already only applies effort when `effortArgvPrefix` is
 * declared, and only applies permission mode when the harness's declared
 * `permissionModes` includes it. */
function applyDefaultSetting(target: Partial<HarnessDefaultSettings & { model: string }>, key: string, value: string, harness?: AiLocalHarnessDefinition): void {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'effort') {
    if (harness && !harnessSupportsEffort(harness)) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag; setting one here would silently do nothing.`);
    if (!VALID_EFFORTS.includes(value as (typeof VALID_EFFORTS)[number])) throw new Error(`effort must be one of ${VALID_EFFORTS.join(', ')}`);
    target.effort = value;
  } else if (normalizedKey === 'permissions' || normalizedKey === 'permissionmode') {
    if (!VALID_PERMISSION_MODES.includes(value as AiHarnessPermissionMode)) throw new Error('permissions must be ask, bypass, or auto');
    if (harness && !harnessSupportsPermissionMode(harness, value as AiHarnessPermissionMode)) throw new Error(`${harness.displayName} does not map ClikCode's permission modes to a real flag; setting one here would silently do nothing.`);
    target.permissionMode = value as AiHarnessPermissionMode;
  } else if (normalizedKey === 'failover') {
    target.accountFailover = normalizeFailoverWord(value);
  } else if (normalizedKey === 'model' && 'model' in target) {
    target.model = value === 'auto' || value === 'default' ? undefined : value;
  } else {
    throw new Error(`unknown setting "${key}"; choose ${'model' in target ? 'model, ' : ''}effort, permissions, or failover`);
  }
}

/** Read-only view of the defaults every new chat is built from. */
/** Applies to every provider that doesn't have its own override. */
export async function aiSettingsSetGlobal(key: string, value: string, emit = true): Promise<void> {
  const state = await readState();
  applyDefaultSetting(state.globalSettings, key, value);
  await writeState(state);
  if (emit) emitJson({ globalSettings: state.globalSettings });
}

/** Overrides the global default for one provider only; existing sessions are untouched. */
export async function aiSettingsSetProvider(providerOrHarness: string, key: string, value: string, emit = true): Promise<void> {
  const state = await readState();
  const harness = localHarnessForCommand(providerOrHarness) ?? localHarnessForProvider(providerOrHarness);
  if (!harness) throw new Error(`unknown provider "${providerOrHarness}"`);
  const entry: Partial<HarnessDefaultSettings & { model: string }> = { ...state.providerSettings[harness.provider] };
  applyDefaultSetting(entry, key, value, harness);
  state.providerSettings[harness.provider] = entry;
  await writeState(state);
  if (emit) emitJson({ provider: harness.provider, settings: entry });
}

/** Removes every override for one provider, falling back to the global defaults. */
export async function aiSettingsClearProvider(providerOrHarness: string, emit = true): Promise<void> {
  const state = await readState();
  const harness = localHarnessForCommand(providerOrHarness) ?? localHarnessForProvider(providerOrHarness);
  if (!harness) throw new Error(`unknown provider "${providerOrHarness}"`);
  delete state.providerSettings[harness.provider];
  await writeState(state);
  if (emit) emitJson({ provider: harness.provider, settings: {} });
}

export async function aiSessionCreate(options: { route: AiHarnessRoute; account?: string; provider?: string; model?: string; effort?: string; accountFailover?: 'never' | 'on-quota-exhausted' }): Promise<void> {
  if (options.route !== 'local' && options.route !== 'gateway') throw new Error('route must be local or gateway');
  if (options.route === 'gateway' && (options.account || options.provider || options.model || options.effort || options.accountFailover)) {
    throw new Error('Gateway account, provider, model, effort, and failover are selected by ClikDeploy platform routing and cannot be overridden per session.');
  }
  if (options.accountFailover !== undefined && options.accountFailover !== 'never' && options.accountFailover !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
  const state = await readState();
  const account = options.account
    ? state.accounts.find((item) => item.id === options.account || item.label === options.account)
    : undefined;
  if (options.route === 'local' && options.account && !account) throw new Error(`local AI account "${options.account}" was not found`);
  const provider = options.provider ?? account?.provider ?? null;
  const harness = provider ? localHarnessForProvider(provider) : undefined;
  if (provider && !harness && options.route === 'local') throw new Error(`unknown local provider "${provider}"`);
  if (options.model && harness && !harness.modelArgvPrefix) throw new Error(`${harness.displayName} does not publish a model selector.`);
  if (options.effort && harness) {
    const effortOption = optionForHarness(harness, 'effort');
    if (!effortOption) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag.`);
    parseHarnessOption(effortOption, options.effort);
  }
  const defaults = resolveDefaultSettings(state, provider);
  const now = new Date().toISOString();
  const id = randomUUID();
  const session: HarnessSession = {
    id, conversationId: id, route: options.route, accountId: options.route === 'gateway' ? null : account?.id ?? null,
    provider: options.route === 'gateway' ? 'clikdeploy-gateway' : provider,
    model: options.route === 'gateway' ? null : options.model ?? (provider ? state.providerSettings[provider]?.model : undefined) ?? null,
    effort: options.route === 'gateway' ? 'platform-managed' : options.effort ?? defaults.effort,
    ...(options.route === 'local' ? { permissionMode: defaults.permissionMode } : {}),
    accountFailover: options.route === 'gateway' ? 'never' : options.accountFailover ?? defaults.accountFailover,
    ...(options.route === 'gateway' ? { gatewayConfirmed: true as const } : {}),
    createdAt: now, updatedAt: now, status: 'active',
  };
  state.sessions.push(session);
  await writeState(state);
  emitJson({ session });
}

export async function aiSessionsList(): Promise<void> {
  const state = await readState();
  emitJson({ sessions: state.sessions });
}

/** Edit the active conversation's approval behavior from the top-level
 * `clikcode permissions` command. The same picker and provider capability
 * checks back the in-chat `/permissions` command, so the two surfaces cannot
 * drift. With no conversation yet, a selection becomes the global default. */
export async function aiPermissions(mode?: string): Promise<void> {
  const normalizedMode = mode?.trim().toLowerCase() as AiHarnessPermissionMode | undefined;
  if (normalizedMode && !VALID_PERMISSION_MODES.includes(normalizedMode)) {
    throw new Error('permissions must be ask, bypass, or auto');
  }
  const state = await readState();
  const session = [...state.sessions]
    .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.updatedAt.localeCompare(left.updatedAt))[0];
  if (normalizedMode) {
    if (session) await aiSessionCommand(session.id, `/permissions ${normalizedMode}`);
    else await aiSettingsSetGlobal('permissions', normalizedMode);
    return;
  }
  if (!terminalUiSupported()) throw new Error('an ANSI-capable interactive terminal is required; use `clikcode permissions ask|bypass|auto`');
  const rl = new TerminalHarnessPrompter();
  activeTerminalHarness = rl;
  try {
    if (session) {
      const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId)?.label : undefined;
      rl.render?.(session, account);
      await interactivePermissionPicker(rl, session.id);
    } else {
      const selected = await chooseOption(rl, 'Choose permissions', VALID_PERMISSION_MODES.map((value) => ({
        label: value[0].toUpperCase() + value.slice(1), value,
      })));
      if (selected) await aiSettingsSetGlobal('permissions', selected);
    }
  } finally {
    activeTerminalHarness = undefined;
    rl.close();
  }
}

/** The very first launch on a machine, with nothing to carry forward. */
function firstEverSession(state: HarnessState, workspace: string, now: string): HarnessSession {
  const defaults = resolveDefaultSettings(state, null);
  const id = randomUUID();
  return {
    id, conversationId: id, route: 'local', accountId: null, provider: null, model: null,
    effort: defaults.effort, permissionMode: defaults.permissionMode,
    accountFailover: defaults.accountFailover, workspace,
    createdAt: now, updatedAt: now, status: 'active',
  };
}

/**
 * The conversation a bare `clikcode` opens. Always a new one: resuming a
 * specific chat is an explicit act -- `/resume`, or `sessions open <id>` --
 * never a side effect of opening a terminal. Picking up the most recent chat
 * meant two terminals opened in a row landed in the same conversation, and it
 * made "start working" and "reopen yesterday's thread" the same gesture.
 *
 * How you work carries over: provider, account, model, effort, permissions.
 * That is a preference, not a conversation. The workspace deliberately does
 * not -- a new conversation belongs to the directory it was launched from, not
 * to wherever the last one happened to run.
 */
export function launchSession(
  state: HarnessState, workspace: string, now = new Date().toISOString(),
): HarnessSession {
  const previous = [...state.sessions]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return previous
    ? { ...newConversationSession(state, previous, now), workspace }
    : firstEverSession(state, workspace, now);
}

export async function aiSessionOpenDefault(config: Conf): Promise<void> {
  const state = await readState();
  const session = launchSession(state, process.cwd());
  state.sessions.push(session);
  await writeState(state);
  await aiSessionInteractive(config, session.id);
}

export async function aiSessionShow(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  emitJson({ session });
}

export async function aiSessionResume(config: Conf, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.status !== 'active') {
    session.status = 'active';
    session.closedAt = undefined;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
  }
  await aiSessionInteractive(config, session.id);
}

/** Close is centralized even when the selected native agent has already exited. */
export async function aiSessionClose(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  // A session that never received a single turn AND was never linked to a
  // real vendor conversation has nothing to resume — keeping it as "closed"
  // clutter buries real conversations under identical "Untitled chat" entries
  // every time the app is opened and exited without typing anything. Drop it
  // outright instead of accumulating it. A set nativeSessionId is kept even
  // with zero ClikCode-tracked messages: it may be adopted from, or linked
  // directly to, a vendor's own conversation that has real content ClikCode
  // just never routed a turn through. A session with nativeHarness set is
  // kept too, even message-less: explicitly choosing a native provider and
  // configuring its account is real, deliberate setup work, not an
  // accidental blank launch. nativeHarness is the reliable signal here
  // specifically because it is ONLY ever set by an explicit selection
  // (aiHarnessSelect, newProviderConversation) -- unlike `provider`,
  // `accountId`, and `route`, which aiSessionOpenDefault's own "create a
  // fresh default session" path silently carries forward from whatever
  // session came before, even when the user has configured nothing yet.
  // gatewayConfirmed is the same signal for the one route (Gateway) that
  // doesn't otherwise have a reliable "was this deliberate" field to check.
  if (!sessionTranscriptMessages(session).length && !session.nativeSessionId && !session.nativeHarness && !session.gatewayConfirmed) {
    state.sessions = state.sessions.filter((item) => item.id !== id);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-closed', sessionId: session.id, closed: true });
  }
  if (session.status !== 'closed') {
    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    await writeState(state);
  }
  emitHarnessOutput({ panel: 'session-closed', sessionId: session.id, closed: true });
}

/** Save-and-leave lifecycle used by /exit. This deliberately does not call
 * aiSessionClose: closing a terminal must not make startup fall back to an
 * older provider branch of the same conversation. */
async function aiSessionLeave(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  markSessionLeftOpen(session, new Date().toISOString());
  await writeState(state);
}

/** Shared slash-command grammar for a future TTY client and the headless CLI. */
function sessionHarness(session: HarnessSession | undefined): AiLocalHarnessDefinition | undefined {
  return session?.route !== 'gateway' && session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
}

function customCommandsFor(session: HarnessSession, harness: AiLocalHarnessDefinition | undefined): CustomCommand[] {
  if (session.route === 'gateway') return [];
  return discoverCustomCommands(harness, { workspace: session.workspace ?? process.cwd(), ...CUSTOM_COMMAND_ROOTS });
}
/** Test seam: redirect `~` and ClikCode's own command directories. */
export const CUSTOM_COMMAND_ROOTS: { home?: string; clikcodeDirs?: readonly string[] } = {};

function slashExtrasFor(session: HarnessSession, harness: AiLocalHarnessDefinition | undefined): SlashExtras {
  const managers = harness ? localHarnessCapabilityManifest(harness).managers ?? {} : {};
  return {
    managers: Object.entries(managers).map(([name, manager]) => ({ name, label: manager?.label ?? name })),
    native: session.route === 'gateway' ? [] : sessionNativeCommands(session.id),
    custom: customCommandsFor(session, harness),
    harnesses: allLocalHarnesses().filter((item) => harnessCanRunTurns(item))
      .map((item, index) => ({ item, index })).sort((a, b) => harnessTierRank(a.item) - harnessTierRank(b.item) || a.index - b.index)
      .map(({ item }) => ({ command: item.command, displayName: item.displayName })),
  };
}

function slashRouteContextFor(
  session: HarnessSession, harness: AiLocalHarnessDefinition | undefined, pathExists?: (path: string) => boolean,
): SlashRouteContext {
  const extras = slashExtrasFor(session, harness);
  return {
    ...(harness ? { harness } : {}),
    harnessCommands: (extras.harnesses ?? []).map((item) => item.command),
    managerNames: (extras.managers ?? []).map((item) => item.name),
    nativeCommands: (extras.native ?? []).map((item) => item.name.replace(/^\//, '').toLowerCase()),
    customCommands: (extras.custom ?? []).map((item) => item.name),
    ...(pathExists ? { pathExists } : {}),
  };
}

/** Everything that differs from the last commit: staged and unstaged changes
 * against HEAD, plus files git does not track yet (which `git diff` never shows). */
async function workspaceDiff(workspace: string): Promise<string> {
  const git = (args: readonly string[]): Promise<string> => captureProcess('git', args, workspace);
  const hasHead = await git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
  // A repository with no commit yet has no HEAD: everything staged is the change.
  const base = hasHead ? ['diff', '--no-ext-diff', 'HEAD'] : ['diff', '--no-ext-diff', '--cached'];
  const [stat, details, untracked] = await Promise.all([
    git([...base, '--stat', '--', '.']), git([...base, '--', '.']),
    git(['ls-files', '--others', '--exclude-standard', '--', '.']).catch(() => ''),
  ]);
  const untrackedFiles = untracked.split(/\r?\n/).filter(Boolean);
  const sections = [
    stat.trim(), details.trim(),
    untrackedFiles.length ? `Untracked files (${untrackedFiles.length}):\n${untrackedFiles.slice(0, 200).map((file) => `  ${file}`).join('\n')}${untrackedFiles.length > 200 ? `\n  … ${untrackedFiles.length - 200} more` : ''}` : '',
  ].filter(Boolean);
  return sections.join('\n\n').slice(0, 512 * 1024);
}

function capabilitiesText(session: HarnessSession): string {
  if (session.route === 'gateway') {
    return [
      'ClikDeploy Gateway capabilities',
      'Inference routing: platform managed',
      'Streaming: live SSE token deltas with bounded fallback chunking',
      'Tools: ClikDeploy capability registry and MCP bridge',
      'Permissions: authenticated server policy and confirmation gates',
      'Sessions: durable ClikCode transcript replay',
      'Models and effort: selected by Gateway routing policy',
    ].join('\n');
  }
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider first.');
  const manifest = localHarnessCapabilityManifest(harness);
  return [
    `${harness.displayName} capabilities`,
    ...manifest.options.map((option) => {
      const control = commonControlFor(option.id);
      return `${option.label}: ${option.description}${control ? ` (${control})` : ''}`;
    }),
    ...Object.entries(manifest.managers ?? {}).map(([name, manager]) => `${manager?.label ?? name}: available`),
    ...(manifest.features ?? []).map((feature) => `${feature}: native`),
  ].join('\n');
}

function memoryFileName(session: HarnessSession): string {
  return sessionHarness(session)?.memoryFile ?? 'AGENTS.md';
}

function initPrompt(session: HarnessSession): string {
  const file = memoryFileName(session);
  return `Inspect this repository and create or improve ${file} with concise, accurate build, test, architecture, and contribution instructions for coding agents. Verify every command you include.`;
}

function reviewPrompt(extra: string): string {
  return `Review the uncommitted changes in this workspace. Identify concrete bugs, regressions, security issues, and missing tests. Prioritize findings and cite file paths.${extra ? ` Additional focus: ${extra}` : ''}`;
}

async function readMemoryFile(session: HarnessSession): Promise<{ path: string; content?: string }> {
  const path = join(session.workspace ?? process.cwd(), memoryFileName(session));
  try {
    return { path, content: (await readFile(path, 'utf8')).slice(0, 256 * 1024) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path };
    throw error;
  }
}

function undoUnavailableMessage(session: HarnessSession): string {
  const harness = sessionHarness(session);
  const who = session.route === 'gateway' ? 'ClikDeploy Gateway' : harness?.displayName ?? 'This provider';
  return `${who} does not expose an undo/rewind operation to ClikCode, so /undo is not available here. ClikCode will not fake it: use /diff to see what changed and git to revert it${harness?.nativeSlashPassthrough ? `, or send the vendor's own command with //rewind` : ''}.`;
}

function formatTokens(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString('en-US');
}

function contextUsageText(session: HarnessSession): string {
  const usage = session.lastUsage;
  const who = session.route === 'gateway' ? 'ClikDeploy Gateway' : sessionHarness(session)?.displayName ?? 'The provider';
  if (!usage) return `${who} has not reported token usage for this conversation yet. It appears here after a turn on a harness that publishes usage events.`;
  const used = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || undefined);
  const window = usage.contextWindow;
  return [
    `Context usage (as of ${usage.at})`,
    window && used !== undefined ? `  window     ${formatTokens(used)} / ${formatTokens(window)} tokens (${Math.min(100, Math.round((used / window) * 100))}%)` : `  window     not reported by ${who}`,
    `  input      ${formatTokens(usage.inputTokens)}`,
    `  cached     ${formatTokens(usage.cacheReadTokens)}`,
    `  output     ${formatTokens(usage.outputTokens)}`,
    `  total      ${formatTokens(used)}`,
    `  messages   ${sessionTranscriptMessages(session).length}`,
  ].join('\n');
}

function costReport(state: HarnessState, session: HarnessSession): { text: string; totals: { turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; costKnown: boolean } } {
  const invocations = state.invocations.filter((item) => item.sessionId === session.id);
  const totals = invocations.reduce((sum, item) => ({
    turns: sum.turns + 1, inputTokens: sum.inputTokens + (item.inputTokens ?? 0), outputTokens: sum.outputTokens + (item.outputTokens ?? 0),
    cacheReadTokens: sum.cacheReadTokens + (item.cacheReadTokens ?? 0), costUsd: sum.costUsd + (item.costUsd ?? 0),
    costKnown: sum.costKnown || item.costUsd !== undefined,
  }), { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, costKnown: false });
  const text = invocations.length
    ? [
      'This conversation',
      `  turns      ${totals.turns}`,
      `  input      ${formatTokens(totals.inputTokens)} tokens`,
      `  cached     ${formatTokens(totals.cacheReadTokens)} tokens`,
      `  output     ${formatTokens(totals.outputTokens)} tokens`,
      `  cost       ${totals.costKnown ? `$${totals.costUsd.toFixed(4)}` : 'not reported (subscription plans and most vendor CLIs do not publish a price)'}`,
    ].join('\n')
    : 'No metered turns recorded for this conversation yet.';
  return { text, totals };
}

function transcriptMarkdown(session: HarnessSession): string {
  const title = session.name ?? `ClikCode conversation ${session.id.slice(0, 8)}`;
  const header = [
    `# ${title}`, '',
    `- Provider: ${sessionProviderLabel(session)}`,
    `- Model: ${session.model ?? 'provider default'}`,
    `- Workspace: ${session.workspace ?? process.cwd()}`,
    `- Exported: ${new Date().toISOString()}`, '',
  ];
  const body = sessionTranscriptMessages(session).flatMap((message) => [`## ${message.role === 'assistant' ? 'Assistant' : 'You'}`, '', message.content.trim(), '']);
  return `${[...header, ...body].join('\n').trimEnd()}\n`;
}

/** Never overwrites silently: `confirmOverwrite` decides (a prompt in the TUI,
 * `--force` headless). */
async function exportTranscript(session: HarnessSession, target: string, confirmOverwrite: (path: string) => Promise<boolean>): Promise<string> {
  const workspace = session.workspace ?? process.cwd();
  const requested = expandHomePath(decodeAttachmentPath(target.trim() || `clikcode-${session.id.slice(0, 8)}.md`));
  const path = isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested);
  const existing = await stat(path).catch(() => undefined);
  if (existing?.isDirectory()) throw new Error(`${compactPath(path)} is a directory; give a file name.`);
  if (existing && !await confirmOverwrite(path)) throw new Error(`${compactPath(path)} already exists; not overwritten. Choose another path${isJsonDefaultMode() ? ' or pass --force' : ''}.`);
  await writeFile(path, transcriptMarkdown(session), { encoding: 'utf8', mode: 0o600 });
  return path;
}

async function resolveExistingDirectory(session: HarnessSession, raw: string): Promise<string> {
  const expanded = expandHomePath(decodeAttachmentPath(raw));
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(session.workspace ?? process.cwd(), expanded);
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`${compactPath(path)} does not exist.`);
  if (!info.isDirectory()) throw new Error(`${compactPath(path)} is not a directory.`);
  return path;
}

/** A native session belongs to the directory it was started in, so moving the
 * conversation drops it (the transcript is replayed into the next one) and
 * closes any live transport child, whose cwd is fixed at spawn. */
async function changeSessionWorkspace(state: HarnessState, session: HarnessSession, raw: string): Promise<string> {
  const path = await resolveExistingDirectory(session, raw);
  if (path === (session.workspace ?? process.cwd())) return `Already working in ${compactPath(path)}.`;
  const droppedNative = Boolean(session.nativeSessionId);
  session.workspace = path;
  session.nativeSessionId = undefined;
  session.nativeStartedAt = undefined;
  delete session.nativeSessionPreallocated;
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  await closePersistentTransport(session.id);
  return `Working directory is now ${compactPath(path)}.${droppedNative ? ' The native session belonged to the previous directory, so the next turn starts a fresh one with this conversation replayed.' : ''}`;
}

/** Stored as the harness's own declared `add-dir` option, so every transport
 * renders it the way the catalog says. No declaration, no pretending. */
async function addSessionDirectory(state: HarnessState, session: HarnessSession, raw: string): Promise<string> {
  if (!raw.trim()) throw new Error('usage: /add-dir <dir>');
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider before adding directories.');
  const option = optionForControl(harness, '/add-dir');
  if (!option) throw new Error(`${harness.displayName} does not declare an additional-directory option; start ClikCode from a common parent directory or use /cwd instead.`);
  const path = await resolveExistingDirectory(session, raw);
  const current = session.harnessOptions?.[option.id];
  const existing = Array.isArray(current) ? current.map(String) : typeof current === 'string' && current ? [current] : [];
  if (existing.includes(path)) return `${compactPath(path)} is already available to ${harness.displayName}.`;
  session.harnessOptions = { ...session.harnessOptions, [option.id]: option.kind === 'path-list' || option.kind === 'string-list' ? [...existing, path] : path };
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  // A live ACP child took its option argv at spawn.
  await closePersistentTransport(session.id);
  return `${harness.displayName} can now also work in ${compactPath(path)}.`;
}

const COMPACT_PROMPT = 'Summarize this conversation so far for a fresh session that will continue the work. Include: the goal, decisions made and why, files created or changed (with paths), commands that matter, the current state, and the concrete next steps. Be complete but concise. Output only the summary.';

/** `/compact`. A harness that runs slash commands itself compacts natively.
 * Otherwise ClikCode does it: one turn produces the summary, then a fresh
 * branch of the same conversation is seeded with only that summary -- with no
 * native session id, so its first turn replays the summary into a brand-new
 * vendor session. The full transcript stays on the original, resumable. */
async function compactConversation(
  id: string, session: HarnessSession, focus: string, send: (id: string, prompt: string) => Promise<void>,
): Promise<string | void> {
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway manages its own context; /compact applies only to local harnesses.');
  if (!hasConversationContent(session)) throw new Error('There is nothing to compact yet.');
  const harness = sessionHarness(session);
  if (harness?.nativeSlashPassthrough && session.nativeSessionId) {
    await send(id, `/compact${focus ? ` ${focus}` : ''}`);
    return;
  }
  await send(id, `${COMPACT_PROMPT}${focus ? `\nPay particular attention to: ${focus}` : ''}`);
  const state = await readState();
  const source = state.sessions.find((item) => item.id === id);
  if (!source) throw new Error(`AI session "${id}" was not found`);
  const summary = [...sessionTranscriptMessages(source)].reverse().find((message) => message.role === 'assistant')?.content.trim();
  if (!summary) throw new Error('The provider returned no summary; the conversation was left as it was.');
  const compacted: HarnessSession = {
    ...newConversationSession(state, source),
    conversationId: conversationIdFor(source), parentSessionId: source.id,
    ...(source.name ? { name: source.name } : {}),
    ...(source.harnessOptions ? { harnessOptions: { ...source.harnessOptions } } : {}),
    messages: [
      { role: 'user', content: 'Summary of the conversation so far (compacted by ClikCode):' },
      { role: 'assistant', content: summary },
    ],
  };
  state.sessions.push(compacted);
  await writeState(state);
  await closePersistentTransport(id);
  return compacted.id;
}

async function nativeManagerListing(state: HarnessState, session: HarnessSession, name: string): Promise<{ label: string; text: string }> {
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider first.');
  const manager = (localHarnessCapabilityManifest(harness).managers as Record<string, { label: string; listArgv?: readonly string[] } | undefined> | undefined)?.[name];
  if (!manager) throw new Error(`${harness.displayName} does not publish a ${name} manager.`);
  if (!manager.listArgv) throw new Error(`${harness.displayName} manages ${manager.label} only in its own interactive UI; open it from the interactive ClikCode session.`);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const text = await captureNativeHarnessOutput(harness, manager.listArgv, turnEnvironment(harness, account), 15_000, session.workspace);
  return { label: manager.label, text: text.trim() || 'No entries.' };
}

/** What one slash command did, for a caller that must follow it. */
interface HeadlessSlashContext {
  id: string; state: HarnessState; session: HarnessSession;
  /** Canonical registry name (aliases already resolved). */
  head: string; args: string; words: string[];
}
/** Resolves with the resulting session id when the command moved the
 * conversation to another session (`/new`, a handoff), otherwise nothing. */
type HeadlessSlashHandler = (context: HeadlessSlashContext) => Promise<string | void>;

const INTERACTIVE_ONLY = (name: string): HeadlessSlashHandler => async () => {
  throw new Error(`/${name} opens a picker and is only available in the interactive ClikCode session.`);
};

/** Indirection so the interactive loop and tests can observe/replace the turn. */
export const SLASH_TURN = { send: (id: string, prompt: string): Promise<void> => aiSessionSend(id, prompt) };
const sendSessionTurn = (id: string, prompt: string): Promise<void> => SLASH_TURN.send(id, prompt);

/** Headless half of the slash registry. Typed by SlashHandlerKey, so a
 * registry entry without a handler here (or a handler without an entry) does
 * not compile; slash-registry.vitest.test.ts asserts the same at runtime. */
export const HEADLESS_SLASH_HANDLERS: Record<SlashHandlerKey, HeadlessSlashHandler> = {
  help: async ({ session }) => {
    const harness = sessionHarness(session);
    const extras = slashExtrasFor(session, harness);
    return emitHarnessOutput({ panel: 'help', helpText: slashHelpText(session, harness, extras), controls: slashControls() });
  },
  status: async ({ state, session }) => {
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId)?.label : undefined;
    return emitHarnessOutput({ panel: 'settings', session, account });
  },
  new: async ({ state, session, args }) => {
    // `/reset` and `/clear` are aliases, not an in-place wipe. Clearing the
    // transcript on the existing record destroyed history with no confirmation.
    // A fresh conversation gives the same clean slate and keeps the previous
    // one resumable. Text after the command is the new conversation's first
    // turn, sent ON the new session -- it used to be dropped, leaving an orphan.
    const created = newConversationSession(state, session);
    state.sessions.push(created);
    await writeState(state);
    if (!args) emitHarnessOutput({ panel: 'conversation-reset', session: created });
    else await sendSessionTurn(created.id, args);
    return created.id;
  },
  permissions: async ({ state, session, words }) => {
    if (session.route === 'gateway') throw new Error('ClikDeploy Gateway permissions are enforced by authenticated platform policy; Ask, Bypass, and Auto apply only to local harnesses.');
    const value = words.shift()?.toLowerCase();
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness) throw new Error('Choose a provider before setting permissions.');
    if (!value) {
      const controls = VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode));
      if (!controls.length) throw new Error(`${harness.displayName} does not map ClikCode's permission modes to a real flag.`);
      return emitHarnessOutput({ panel: 'permissions', session, controls });
    }
    setSessionHarnessOption(session, harness, 'permissions', value);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  history: async ({ session }) => {
    return emitHarnessOutput({ panel: 'history', messages: sessionTranscriptMessages(session) });
  },
  copy: async ({ session }) => {
    const last = sessionTranscriptMessages(session).reverse().find((message) => message.role === 'assistant');
    if (!last) throw new Error('There is no assistant response to copy yet.');
    const via = await copyToClipboard(last.content);
    return emitHarnessOutput({ panel: 'copied', text: via === 'osc52' ? 'Last response sent to your terminal clipboard (OSC 52).' : 'Last response copied to the clipboard.' });
  },
  mention: async ({ state, session, words }) => {
    const action = words.join(' ').trim();
    if (!action) return emitHarnessOutput({ panel: 'attachments', attachments: session.attachments ?? [] });
    if (action === 'clear') {
      session.attachments = [];
    } else {
      const unquoted = decodeAttachmentPath(action);
      const workspace = session.workspace ?? process.cwd();
      const expanded = expandHomePath(unquoted);
      const path = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded);
      await queueAttachment(session, path);
    }
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'attachments', attachments: session.attachments ?? [] });
  },
  diff: async ({ session }) => {
    return emitHarnessOutput({ panel: 'diff', diff: await workspaceDiff(session.workspace ?? process.cwd()) });
  },
  review: async ({ id, session, head, words }) => {
    // Gateway refusal lives in the registry's availability(), shared by both dispatchers.
    return sendSessionTurn(id, head === 'review' ? reviewPrompt(words.join(' ').trim()) : initPrompt(session));
  },
  rename: async ({ state, session, words }) => {
    const name = words.join(' ').trim();
    if (!name) throw new Error('Enter a name after /rename.');
    session.name = name.slice(0, 120);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-renamed', text: `Conversation renamed to “${session.name}”.` });
  },
  archive: async ({ state, session }) => {
    session.status = 'archived';
    session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-archived', text: 'Conversation archived.' });
  },
  delete: async ({ id, state, session, words }) => {
    if (words[0]?.toLowerCase() !== 'confirm') throw new Error('Use /delete confirm to permanently delete this ClikCode conversation. Provider-owned history is not deleted.');
    state.sessions = state.sessions.filter((item) => item.id !== id);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-deleted', text: 'Conversation deleted from ClikCode.' });
  },
  fork: async ({ id, state, session, words }) => {
    const now = new Date().toISOString();
    const fork: HarnessSession = {
      ...session, id: randomUUID(), name: words.join(' ').trim() || (session.name ? `${session.name} (fork)` : undefined),
      conversationId: conversationIdFor(session), parentSessionId: session.id,
      messages: sessionTranscriptMessages(session), pendingTurn: undefined,
      nativeSessionId: undefined, nativeStartedAt: undefined, createdAt: now, updatedAt: now, status: 'active', closedAt: undefined,
    };
    // A fork is a sibling concept, not another copy of the handoff event that
    // created its parent. Its parentSessionId is sufficient ancestry.
    delete fork.handoff;
    state.sessions.push(fork);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-forked', text: `Conversation forked as ${fork.id.slice(0, 8)}. Use /resume to open it.`, session: fork });
  },
  model: async ({ state, session, words }) => {
    const value = words.join(' ').trim();
    if (!value) throw new Error('Choose a model from /model or use /model <name>.');
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness?.modelArgvPrefix) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a model selector.`);
    session.model = value === 'default' || value === 'auto' ? null : value;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  effort: async ({ state, session, words }) => {
    const value = words.join(' ').trim().toLowerCase();
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness) throw new Error('Choose a provider before setting effort.');
    setSessionHarnessOption(session, harness, 'effort', value);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  account: async ({ id, words }) => {
    return aiSessionCommand(id, words.length ? `/accounts use ${words.join(' ')}` : '/accounts');
  },
  sessions: async ({ id, state, session, words }) => {
    const action = words.shift()?.toLowerCase();
    const targetId = words.shift();
    if (action === 'close') {
      if (!targetId) throw new Error('usage: /sessions close <id>');
      return aiSessionClose(targetId);
    }
    if (action === 'show' || action === 'open' || action === 'resume') {
      if (!targetId) throw new Error(`usage: /sessions ${action} <id>`);
      const target = state.sessions.find((item) => item.id === targetId);
      if (!target) throw new Error(`AI session "${targetId}" was not found`);
      return emitHarnessOutput({ panel: 'session', session: target, next: `${harnessCommand()} sessions open ${target.id}` });
    }
    if (action && action !== 'list' && action !== 'ls') throw new Error('usage: /sessions [list|show <id>|open <id>|close <id>]');
    return emitHarnessOutput({
      panel: 'sessions',
      sessions: state.sessions.map((item) => ({
        id: item.id, status: item.status, harness: item.nativeHarness, nativeSessionId: item.nativeSessionId,
        provider: item.provider, model: item.model, workspace: item.workspace, updatedAt: item.updatedAt,
      })),
      controls: ['sessions list', 'sessions open <id>', 'sessions close <id>'],
    });
  },
  models: async ({ state, session }) => {
    return emitHarnessOutput({
      panel: 'models',
      models: state.accounts.flatMap((account) => account.models.map((model) => ({ account: account.label, provider: account.provider, model }))),
      selected: session.model,
    });
  },
  usage: async ({ state, session }) => {
    const invocations = state.invocations.filter((invocation) => invocation.accountId === session.accountId || (session.route === 'gateway' && invocation.accountId === 'gateway'));
    return emitHarnessOutput({
      panel: 'usage', invocations,
      totals: invocations.reduce((total, invocation) => ({ calls: total.calls + 1, inputTokens: total.inputTokens + (invocation.inputTokens ?? 0), outputTokens: total.outputTokens + (invocation.outputTokens ?? 0) }), { calls: 0, inputTokens: 0, outputTokens: 0 }),
    });
  },
  settings: async ({ id, state, session, words }) => {
    const setting = words.shift()?.toLowerCase();
    const value = words.join(' ').trim();
    if (!setting) return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
    if (setting === 'global') {
      const [key, ...rest] = words;
      if (!key || !rest.length) throw new Error('usage: /settings global <effort|permissions|failover> <value>');
      await aiSettingsSetGlobal(key, rest.join(' '), false);
      return emitHarnessOutput({ panel: 'settings-updated', text: `Global default updated: ${key} = ${rest.join(' ')}` });
    }
    if (setting === 'provider') {
      const [providerId, key, ...rest] = words;
      if (!providerId || !key) throw new Error('usage: /settings provider <id> <model|effort|permissions|failover> <value>, or /settings provider <id> clear');
      if (key.toLowerCase() === 'clear') {
        await aiSettingsClearProvider(providerId, false);
        return emitHarnessOutput({ panel: 'settings-updated', text: `Provider defaults cleared for ${providerId}` });
      }
      if (!rest.length) throw new Error('usage: /settings provider <id> <key> <value>');
      await aiSettingsSetProvider(providerId, key, rest.join(' '), false);
      return emitHarnessOutput({ panel: 'settings-updated', text: `${providerId} default updated: ${key} = ${rest.join(' ')}` });
    }
    if (!value) throw new Error(`usage: /settings ${setting} <value>`);
    if (setting === 'route') {
      if (value !== 'local' && value !== 'gateway') throw new Error('route must be local or gateway');
      if (value === 'gateway') applyGatewaySessionPolicy(session);
      else if (session.route === 'gateway') applyFreshLocalSessionPolicy(state, session);
      else session.route = 'local';
    } else if (setting === 'account') {
      const account = state.accounts.find((item) => item.id === value || item.label.toLowerCase() === value.toLowerCase());
      if (!account) throw new Error(`local AI account "${value}" was not found`);
      const leavingGateway = session.route === 'gateway';
      if (leavingGateway) applyFreshLocalSessionPolicy(state, session);
      const accountHarness = localHarnessForProvider(account.provider);
      if (accountHarness && harnessCanRunTurns(accountHarness) && session.nativeHarness !== accountHarness.command) {
        session.nativeHarness = accountHarness.command;
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      } else if (session.accountId !== account.id) {
        // A native thread id is only valid within the specific account's
        // own isolated profile it was created under -- switching to a
        // DIFFERENT account of the SAME provider left it untouched here,
        // even though it's now meaningless (points at a rollout file that
        // exists only under the old account's profile, not this one).
        // Confirmed live: this produced exactly "no rollout found for
        // thread id ..." on the next resume. Clearing it here means the
        // existing failoverPrompt rehydration path (which already handles
        // "no native thread yet, but real prior messages exist") takes
        // over on the next turn instead of failing outright.
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      }
      session.accountId = account.id;
      session.provider = account.provider;
      session.route = 'local';
      if (leavingGateway) {
        const defaults = resolveDefaultSettings(state, account.provider);
        session.model = state.providerSettings[account.provider]?.model ?? null;
        session.effort = defaults.effort;
        session.permissionMode = defaults.permissionMode;
        session.accountFailover = defaults.accountFailover;
      }
      account.quotaState = 'available';
      account.quotaRetryAt = undefined;
    } else if (setting === 'model') {
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness?.modelArgvPrefix) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a model selector.`);
      session.model = value === 'default' || value === 'auto' ? null : value;
    } else if (setting === 'effort') {
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness) throw new Error('Choose a provider before setting effort.');
      setSessionHarnessOption(session, harness, 'effort', value);
    } else if (setting === 'permissions' || setting === 'permission') {
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness) throw new Error('Choose a provider before setting permissions.');
      setSessionHarnessOption(session, harness, 'permissions', value);
    } else if (setting === 'option') {
      const [optionId, ...optionValue] = value.split(/\s+/);
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness || !optionId || !optionValue.length) throw new Error('usage: /settings option <id> <value>');
      setSessionHarnessOption(session, harness, optionId, optionValue.join(' '));
    } else if (setting === 'accountfailover' || setting === 'account-failover') {
      if (value !== 'never' && value !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
      session.accountFailover = value;
    } else if (setting === 'native-session') {
      if (!session.nativeHarness) throw new Error('select a native harness before attaching its session id');
      const selectedHarness = localHarnessForCommand(session.nativeHarness);
      if (!selectedHarness?.session?.resumeIdPrefix) throw new Error(`${selectedHarness?.displayName ?? session.nativeHarness} does not support exact session resume`);
      session.nativeSessionId = value;
    } else {
      throw new Error(`unknown setting: ${setting}`);
    }
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  accounts: async ({ id, state, session, words }) => {
    const action = words.shift()?.toLowerCase();
    if (action === 'use' || action === 'select') {
      const labelOrId = words.join(' ').trim();
      if (!labelOrId) throw new Error('usage: /accounts use <label-or-id>');
      const account = state.accounts.find((item) => item.id === labelOrId || item.label.toLowerCase() === labelOrId.toLowerCase());
      if (!account) throw new Error(`local AI account "${labelOrId}" was not found`);
      const leavingGateway = session.route === 'gateway';
      if (leavingGateway) applyFreshLocalSessionPolicy(state, session);
      if (session.nativeHarness) {
        const selectedHarness = localHarnessForCommand(session.nativeHarness);
        if (selectedHarness && selectedHarness.provider !== account.provider) throw new Error(`account "${account.label}" belongs to ${account.provider}; select /${localHarnessForProvider(account.provider)?.command ?? account.provider} first`);
      }
      const accountHarness = localHarnessForProvider(account.provider);
      if (accountHarness && harnessCanRunTurns(accountHarness) && session.nativeHarness !== accountHarness.command) {
        session.nativeHarness = accountHarness.command;
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      } else if (session.accountId !== account.id) {
        // A native thread id is only valid within the specific account's
        // own isolated profile it was created under -- switching to a
        // DIFFERENT account of the SAME provider left it untouched here,
        // even though it's now meaningless (points at a rollout file that
        // exists only under the old account's profile, not this one).
        // Confirmed live: this produced exactly "no rollout found for
        // thread id ..." on the next resume. Clearing it here means the
        // existing failoverPrompt rehydration path (which already handles
        // "no native thread yet, but real prior messages exist") takes
        // over on the next turn instead of failing outright.
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      }
      session.accountId = account.id;
      // Explicit selection is the user's retry signal for an account previously
      // marked exhausted. Automatic routing never guesses a reset time.
      account.quotaState = 'available';
      account.quotaRetryAt = undefined;
      session.provider = account.provider;
      session.route = 'local';
      if (leavingGateway) {
        const defaults = resolveDefaultSettings(state, account.provider);
        session.model = state.providerSettings[account.provider]?.model ?? null;
        session.effort = defaults.effort;
        session.permissionMode = defaults.permissionMode;
        session.accountFailover = defaults.accountFailover;
      }
      session.updatedAt = new Date().toISOString();
      await writeState(state);
      return emitHarnessOutput({ panel: 'accounts', selected: accountView(account), session });
    }
    if (action === 'login') {
      const harnessName = words.shift()?.toLowerCase();
      if (!harnessName) throw new Error('usage: /accounts login <harness> [label]');
      await aiAccountLogin(harnessName, words.join(' ') || undefined);
      return;
    }
    if (action === 'remove' || action === 'rm') {
      const labelOrId = words.join(' ').trim();
      if (!labelOrId) throw new Error('usage: /accounts remove <label-or-id>');
      return aiAccountRemove(labelOrId);
    }
    if (action === 'add') {
      const shortcut = words.shift()?.toLowerCase();
      const provider = shortcut ? (localHarnessForCommand(shortcut)?.provider ?? shortcut) : undefined;
      if (!provider) throw new Error('usage: /accounts add <harness>');
      const knownHarness = shortcut ? localHarnessForCommand(shortcut) : undefined;
      if (knownHarness?.surface === 'terminal') { await aiAccountLogin(knownHarness.command, words.join(' ') || undefined); return; }
      return emitHarnessOutput({ panel: 'add-account', provider, next: `${harnessCommand()} accounts add --provider ${provider} --label <label> --auth oauth|api-key|vendor-cli --credential-ref <local-reference>`, credentialBoundary: 'local-only' });
    }
    if (action === 'failover') {
      const setting = words.shift();
      if (setting !== 'auto' && setting !== 'never') throw new Error('usage: /accounts failover auto|never');
      session.accountFailover = setting === 'auto' ? 'on-quota-exhausted' : 'never';
      session.updatedAt = new Date().toISOString();
      await writeState(state);
      return emitHarnessOutput({ panel: 'accounts', session, accountFailover: session.accountFailover });
    }
    return emitHarnessOutput({ panel: 'accounts', session, accounts: state.accounts.map(accountView), controls: ['use <label-or-id>', 'login <harness> [label]', 'add <harness> [label]', 'remove <label-or-id>', 'failover auto|never'] });
  },
  gateway: async ({ state, session }) => {
    if (sessionTranscriptMessages(session).length || session.nativeSessionId) {
      throw new Error('Use the interactive /provider menu to hand off an existing conversation to ClikDeploy Gateway.');
    }
    applyGatewaySessionPolicy(session);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'provider-selected', harness: 'gateway', displayName: 'ClikDeploy Gateway', provider: 'clikdeploy-gateway', account: null, model: 'platform', centralized: true });
  },
  attachments: (context) => HEADLESS_SLASH_HANDLERS.mention(context),
  init: (context) => HEADLESS_SLASH_HANDLERS.review(context),
  redraw: async () => emitHarnessOutput({ panel: 'redraw', text: 'Nothing to repaint outside the interactive session.' }),
  exit: async ({ id }) => aiSessionLeave(id),
  provider: INTERACTIVE_ONLY('provider'),
  resume: INTERACTIVE_ONLY('resume'),
  options: INTERACTIVE_ONLY('options'),
  capabilities: async ({ session }) => emitHarnessOutput({ panel: 'capabilities', text: capabilitiesText(session) }),
  native: async ({ id, session, args }) => {
    if (!args) throw new Error('usage: /native <text>  (or //text)');
    if (session.route === 'gateway') throw new Error('Native harness commands apply only to local harnesses.');
    await sendSessionTurn(id, args);
  },
  compact: async ({ id, session, args }) => compactConversation(id, session, args, sendSessionTurn),
  context: async ({ session }) => emitHarnessOutput({ panel: 'context', text: contextUsageText(session), usage: session.lastUsage ?? null }),
  cost: async ({ state, session }) => {
    const report = costReport(state, session);
    return emitHarnessOutput({ panel: 'cost', text: report.text, totals: report.totals });
  },
  export: async ({ session, words }) => {
    const force = words.includes('--force');
    const path = await exportTranscript(session, words.filter((word) => word !== '--force').join(' '), async () => force);
    return emitHarnessOutput({ panel: 'exported', text: `Transcript written to ${compactPath(path)}.`, path });
  },
  cwd: async ({ state, session, args }) => {
    if (!args) return emitHarnessOutput({ panel: 'cwd', text: compactPath(session.workspace ?? process.cwd()), workspace: session.workspace ?? process.cwd() });
    const notice = await changeSessionWorkspace(state, session, args);
    return emitHarnessOutput({ panel: 'cwd', text: notice, workspace: session.workspace });
  },
  'add-dir': async ({ state, session, args }) => emitHarnessOutput({ panel: 'add-dir', text: await addSessionDirectory(state, session, args) }),
  memory: async ({ session, words }) => {
    if (words[0]?.toLowerCase() === 'edit') throw new Error('/memory edit opens $EDITOR and is only available in the interactive ClikCode session.');
    const memory = await readMemoryFile(session);
    return emitHarnessOutput({ panel: 'memory', text: `${compactPath(memory.path)}\n\n${memory.content ?? '(not created yet — /init writes it)'}`, path: memory.path, exists: memory.content !== undefined });
  },
  doctor: async () => aiDoctor(),
  login: async ({ session }) => {
    const harness = sessionHarness(session);
    if (!harness) throw new Error('Choose a provider before signing in.');
    await aiAccountLogin(harness.command);
  },
  logout: async ({ state, session }) => {
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
    if (!account) throw new Error('This conversation has no account to sign out.');
    await aiAccountLogout(account.id);
  },
  undo: async ({ session }) => { throw new Error(undoUnavailableMessage(session)); },
};

export async function aiSessionCommand(id: string, input: string): Promise<string> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const text = input.trim();
  if (!text.replace(/^\/+/, '')) throw new Error('slash command is required');
  const harness = sessionHarness(session);
  const route = routeSlashInput(text.startsWith('/') ? text : `/${text}`, slashRouteContextFor(session, harness));
  if (route.kind === 'command') {
    const availability = route.entry.availability(session, harness);
    if (!availability.available) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
    const moved = await HEADLESS_SLASH_HANDLERS[route.entry.handlerKey]({ id, state, session, head: route.entry.name, args: route.args, words: [...route.words] });
    return typeof moved === 'string' ? moved : id;
  }
  if (route.kind === 'harness') {
    // `/<harness> [request]`: a conversation with content hands off to a new
    // branch. The caller must follow the returned id -- the interactive loop
    // adopts it; the turn, if any, runs on THAT session.
    const targetId = requiresProviderHandoff(session, route.command)
      ? await newProviderConversation(id, route.command)
      : id;
    if (targetId === id) await aiHarnessSelect(route.command, targetId);
    if (route.args) await sendSessionTurn(targetId, route.args);
    return targetId;
  }
  if (route.kind === 'manager') {
    const listing = await nativeManagerListing(state, session, route.name);
    emitHarnessOutput({ panel: route.name, text: `${listing.label}\n\n${listing.text}` });
    return id;
  }
  if (route.kind === 'custom') {
    const command = customCommandsFor(session, harness).find((item) => item.name === route.name);
    if (!command) throw new Error(`custom command /${route.name} is no longer available`);
    await sendSessionTurn(id, customCommandPrompt(command, route.args, harness));
    return id;
  }
  if (route.kind === 'native') {
    if (session.route === 'gateway') throw new Error('Native harness commands apply only to local harnesses.');
    await sendSessionTurn(id, route.prompt);
    return id;
  }
  if (route.kind === 'unknown') throw new Error(unknownSlashMessage(route));
  throw new Error('slash command is required');
}

/** Maintenance actions are deliberately narrow label/value pairs rather than
 * nested PickerOptions. Non-destructive actions open with Tab; destructive
 * deleteAction values open only from Delete and are confirmed by select(). */

async function chooseOption<T>(
  rl: HarnessPrompter,
  title: string,
  options: readonly PickerOption<T>[],
  onAction?: (value: T, action: string) => Promise<void>,
  settings?: {
    onBack?: () => void;
    onEscape?: () => void;
    refreshedOptions?: () => readonly PickerOption<T>[];
    refresh?: Promise<unknown>;
  },
): Promise<T | undefined> {
  if (options.length === 0) return undefined;
  if (rl.select) return rl.select(title, options, onAction, settings);
  output.write(`\n${chalk.bold(title)}\n`);
  options.forEach((option, index) => {
    output.write(`  ${chalk.cyan(String(index + 1).padStart(2))}  ${option.label}${option.detail ? ` ${chalk.dim(option.detail)}` : ''}\n`);
  });
  output.write(`  ${chalk.dim('0   Cancel')}\n\n`);
  const answer = (await rl.question(chalk.bold('Choose › '))).trim();
  if (!answer || answer === '0') return undefined;
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= options.length) {
    emitHarnessOutput({ panel: 'error', message: `Choose a number from 1 to ${options.length}.` });
    return undefined;
  }
  return options[index].value;
}

/** A brand-new conversation root. How you want to work (provider, account,
 * model, effort, permissions, workspace) carries over; what you were talking
 * about does not. Crucially it takes a fresh conversationId and no parent, so
 * it lists as its own row in /resume instead of merging into the conversation
 * it was started from, and it carries no inherited name. */
export function newConversationSession(
  state: HarnessState, source: HarnessSession, now = new Date().toISOString(),
): HarnessSession {
  const id = randomUUID();
  const defaults = resolveDefaultSettings(state, source.provider);
  return {
    id, conversationId: id, route: source.route,
    accountId: source.route === 'gateway' ? null : source.accountId ?? null,
    provider: source.provider, model: source.model ?? null,
    effort: source.effort ?? defaults.effort,
    ...(source.route === 'gateway' ? {} : { permissionMode: source.permissionMode ?? defaults.permissionMode }),
    accountFailover: source.accountFailover ?? defaults.accountFailover,
    workspace: source.workspace ?? process.cwd(),
    ...(source.nativeHarness ? { nativeHarness: source.nativeHarness } : {}),
    createdAt: now, updatedAt: now, status: 'active',
  };
}

/** Starting a clean conversation leaves the previous one intact and resumable;
 * the caller switches to the returned id. */
/** Drop a queued turn that could not start, so a permanent failure cannot
 * replay forever at the head of the queue. */
async function releaseQueuedTurn(id: string, queuedTurnId: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (session && consumeSessionTurn(session, queuedTurnId)) await writeState(state);
}

async function newConversation(currentId: string): Promise<string> {
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  const created = newConversationSession(state, current);
  state.sessions.push(created);
  await writeState(state);
  return created.id;
}

async function newProviderConversation(currentId: string, harnessCommandName: string): Promise<string> {
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  if (current.route === 'local' && current.nativeHarness === harness.command) return current.id;
  // Refresh the source before freezing its portable ClikCode history into a
  // child branch. The source native session remains untouched after this.
  if (await synchronizeNativeTranscript(state, current)) await writeState(state);
  const accounts = state.accounts.filter((account) => account.provider === harness.provider && account.status === 'ready');
  const defaults = resolveDefaultSettings(state, harness.provider);
  const now = new Date().toISOString();
  const sourceDisplayName = current.nativeHarness
    ? localHarnessForCommand(current.nativeHarness)?.displayName
    : sessionProviderLabel(current);
  const session = createHandoffBranch({
    source: current, target: harness, accountId: accounts.length === 1 ? accounts[0]!.id : null,
    model: state.providerSettings[harness.provider]?.model ?? null, defaults, now, sourceDisplayName,
  });
  state.sessions.push(session);
  await writeState(state);
  await aiHarnessSelect(harnessCommandName, session.id);
  return session.id;
}

async function ensureGatewayLogin(config: Conf, rl: HarnessPrompter): Promise<void> {
  const apiUrl = getApiUrl(config);
  if (getApiKeyForUrl(config, apiUrl)) return;
  const provider = await chooseOption(rl, 'Sign in to ClikDeploy Gateway', [
    { label: 'Continue with Google', value: 'google' as const },
    { label: 'Continue with GitHub', value: 'github' as const },
  ]);
  if (!provider) throw new Error('ClikDeploy Gateway sign-in was cancelled.');
  if (rl instanceof TerminalHarnessPrompter) await rl.suspend();
  try {
    await gatewayLogin(config, { google: provider === 'google', github: provider === 'github', embedded: true });
  } finally {
    if (rl instanceof TerminalHarnessPrompter) rl.resume();
  }
  if (!getApiKeyForUrl(config, apiUrl)) throw new Error('ClikDeploy OAuth completed without storing a Gateway credential.');
}

async function newGatewayConversation(config: Conf, rl: HarnessPrompter, currentId: string): Promise<string> {
  await ensureGatewayLogin(config, rl);
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  if (current.route === 'gateway') return current.id;
  if (!hasConversationContent(current) && !current.nativeHarness) {
    applyGatewaySessionPolicy(current);
    current.updatedAt = new Date().toISOString();
    await writeState(state);
    return current.id;
  }
  if (await synchronizeNativeTranscript(state, current)) await writeState(state);
  const now = new Date().toISOString();
  const id = randomUUID();
  const session: HarnessSession = {
    id, conversationId: conversationIdFor(current), parentSessionId: current.id,
    handoff: { fromSessionId: current.id, fromHarness: current.nativeHarness ?? current.route, at: now },
    route: 'gateway', accountId: null, provider: 'clikdeploy-gateway', model: null,
    effort: 'platform-managed', accountFailover: 'never',
    workspace: current.workspace ?? process.cwd(), name: current.name?.replace(/\s+\(from [^)]+\)$/i, '').trim() || undefined,
    ...(sessionTranscriptMessages(current).length
      ? { messages: sessionTranscriptMessages(current).map((message) => ({ ...message })) }
      : {}),
    createdAt: now, updatedAt: now, status: 'active',
    gatewayConfirmed: true,
  };
  state.sessions.push(session);
  await writeState(state);
  return session.id;
}

export type ProviderChoice =
  | { kind: 'gateway' }
  | { kind: 'provider'; harness: string }
  | { kind: 'more' };

export type ProviderAccountChoice =
  | { kind: 'account'; harness: string; accountId: string }
  | { kind: 'add-account'; harness: string };

function integrationLabel(harness: AiLocalHarnessDefinition): string {
  return ({
    native: 'full integration',
    structured: 'structured integration',
    compatibility: 'basic compatibility',
    'editor-only': 'editor only',
  } as const)[harnessIntegrationLevel(harness)];
}

/** Keep the provider list deliberately sparse. Account switching belongs to
 * the composer shortcut and /account, not this provider-only menu. */
export function providerPickerOptions(
  available: ReadonlyArray<{ harness: AiLocalHarnessDefinition; inspection: { installed: boolean; version?: string } }>,
  session: HarnessSession,
  gatewayConnected: boolean,
  configuredProviders: ReadonlySet<string> = new Set(),
  includeAll = false,
): PickerOption<ProviderChoice>[] {
  // Installed first, then the catalog's declared tier, then catalog order
  // (Array.prototype.sort is stable) -- never a hardcoded name ranking.
  const ordered = [...available].sort((left, right) => Number(right.inspection.installed) - Number(left.inspection.installed)
    || harnessTierRank(left.harness) - harnessTierRank(right.harness));
  const visible = includeAll ? ordered : ordered.filter(({ harness, inspection }) => inspection.installed
    || configuredProviders.has(harness.provider) || session.nativeHarness === harness.command);
  const hiddenCount = ordered.length - visible.length;
  return [{
    label: 'ClikDeploy Gateway',
    detail: `· ${gatewayConnected ? 'connected' : 'sign in with OAuth'}${session.route === 'gateway' ? ' · current' : ''}`,
    value: { kind: 'gateway' },
  }, ...visible.map(({ harness, inspection }) => ({
      label: harness.displayName,
      detail: `${inspection.installed
        ? `· installed${inspection.version ? ` ${inspection.version}` : ''}`
        : harness.npmPackage ? '· install when needed' : '· vendor install required'} · ${integrationLabel(harness)}${session.route === 'local' && session.nativeHarness === harness.command ? ' · current' : ''}`,
      value: { kind: 'provider' as const, harness: harness.command },
    })), ...(hiddenCount > 0 ? [{ label: 'More providers…', detail: `· ${hiddenCount} available to install`, value: { kind: 'more' as const } }] : []),
  ];
}

/** Whether the account menu can actually complete an add operation. */
export function harnessCanAddAccount(harness: AiLocalHarnessDefinition): boolean {
  return harness.localAuth.includes('api-key') || Boolean(harness.loginArgv);
}

/** Account usage is loaded only after its provider is opened, avoiding a
 * wall of rows and avoiding quota probes for providers the user never views. */
export function providerAccountPickerOptions(
  harness: AiLocalHarnessDefinition,
  accounts: ReadonlyArray<{ account: AiHarnessAccount; usage?: string; usagePending?: boolean }>,
  session: HarnessSession,
): PickerOption<ProviderAccountChoice>[] {
  return [
    ...[...accounts].sort((left, right) => left.account.label.localeCompare(right.account.label)).map(({ account, usage, usagePending }) => {
      const actions = [
        ...(harness.loginArgv && account.authKind === 'vendor-cli' && account.status !== 'ready'
          ? [{ label: 'Reauthenticate', value: 'reauthenticate' }] : []),
      ];
      const deleteAction = harness.logoutArgv && account.authKind === 'vendor-cli' && account.status === 'ready'
        ? { label: 'Disconnect', value: 'disconnect' }
        : { label: 'Remove', value: 'remove' };
      return {
        label: account.label,
        detail: `${usage ? `· ${usage} ` : usagePending ? '· checking usage… ' : '· usage unavailable '}${account.authKind === 'api-key' ? '· direct API ' : '· native CLI '}${account.status !== 'ready' ? `· ${chalk.yellow('needs sign-in')} ` : ''}${account.quotaState === 'exhausted' ? `· ${chalk.yellow('quota exhausted')} ` : ''}${account.id === session.accountId ? '· current' : ''}${actions.length ? ` ${chalk.dim('(Tab for options)')}` : ''}`.trim(),
        value: { kind: 'account' as const, harness: harness.command, accountId: account.id },
        actions,
        deleteAction,
      };
    }),
    ...(harnessCanAddAccount(harness)
      ? [{ label: '+ Add account…', detail: `· ${harness.displayName}`, value: { kind: 'add-account' as const, harness: harness.command } }]
      : []),
  ];
}

/** Composer account choices are scoped to the selected provider. */
export function accountPickerOptions(
  accounts: ReadonlyArray<{ account: AiHarnessAccount; usage?: string; usagePending?: boolean }>,
  session: HarnessSession,
  harness: AiLocalHarnessDefinition,
): PickerOption<ProviderAccountChoice>[] {
  return providerAccountPickerOptions(harness, accounts.filter(({ account }) => account.provider === harness.provider), session)
    .filter((option) => option.value.kind === 'account');
}

async function selectProviderConversation(config: Conf, rl: HarnessPrompter, id: string, selected: string): Promise<string> {
  if (selected === '__gateway__') return newGatewayConversation(config, rl, id);
  const state = await readState();
  const current = state.sessions.find((item) => item.id === id);
  if (!current) throw new Error(`AI session "${id}" was not found`);
  if (!requiresProviderHandoff(current, selected) && !current.nativeHarness) {
    await aiHarnessSelect(selected, id);
    return id;
  }
  return newProviderConversation(id, selected);
}

async function interactiveAccountPicker(
  rl: HarnessPrompter,
  id: string,
): Promise<string | undefined> {
  for (;;) {
    const state = await readState();
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`AI session "${id}" was not found`);
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
      : session.provider ? localHarnessForProvider(session.provider) : undefined;
    if (!harness || session.route === 'gateway') {
      rl.panel?.('Accounts', 'Choose a local provider before switching accounts.');
      return undefined;
    }
    const providerAccounts = state.accounts.filter((account) => account.provider === harness.provider);
    if (!providerAccounts.length) {
      rl.panel?.(`${harness.displayName} accounts`, `No accounts are connected. Use /accounts login ${harness.command} <label> to add one.`);
      return undefined;
    }
    let usagePending = true;
    const accountOptions = (): PickerOption<ProviderAccountChoice>[] => accountPickerOptions(
      providerAccounts.map((account) => ({
        account,
        usage: cachedAccountUsageLabel(account, state),
        usagePending: usagePending && account.authKind === 'vendor-cli',
      })),
      session,
      harness,
    );
    // The one reading a harness cannot give us: an account this session has
    // not driven has no stream to have reported on. Asking the vendor for it
    // happens here and only here -- when someone opened the account picker to
    // compare accounts -- rather than on every paint of every terminal.
    const usageRefresh = Promise.allSettled(providerAccounts.map((account) => accountUsageLabel(account, state, { network: true })))
      .then(() => { usagePending = false; });
    let actionPerformed = false;
    let backedOut = false;
    const selected = await chooseOption(
      rl, `${harness.displayName} accounts`, accountOptions(),
      async (choice, action) => {
        if (choice.kind !== 'account') return;
        actionPerformed = true;
        await manageAccountAction(rl, choice.accountId, action);
      },
      { onBack: () => { backedOut = true; }, refreshedOptions: accountOptions, refresh: usageRefresh },
    );
    if (backedOut) {
      if (rl instanceof TerminalHarnessPrompter) rl.restoreDraft('/');
      return undefined;
    }
    if (actionPerformed) continue;
    if (!selected || selected.kind !== 'account') return undefined;
    await aiSessionCommand(id, `/settings account ${selected.accountId}`);
    return id;
  }
}

async function interactiveEnginePicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  for (;;) {
    const available = await Promise.all(allLocalHarnesses()
      .filter((harness) => harnessCanRunTurns(harness))
      .map(async (harness) => ({ harness, inspection: await inspectNativeHarnessForPicker(harness) })));
    const state = await readState();
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`AI session "${id}" was not found`);
    const gatewayConnected = Boolean(getApiKeyForUrl(config, getApiUrl(config)));
    const configuredProviders = new Set(state.accounts.map((account) => account.provider));
    let provider = await chooseOption(rl, 'Choose a provider', providerPickerOptions(available, session, gatewayConnected, configuredProviders));
    if (!provider) return undefined;
    if (provider.kind === 'more') {
      const primaryHarnesses = new Set(providerPickerOptions(available, session, gatewayConnected, configuredProviders)
        .flatMap((option) => option.value.kind === 'provider' ? [option.value.harness] : []));
      const more = providerPickerOptions(available, session, gatewayConnected, configuredProviders, true)
        .filter((option) => option.value.kind === 'provider' && !primaryHarnesses.has(option.value.harness));
      provider = await chooseOption(rl, 'More providers', more);
      if (!provider) continue;
    }
    if (provider.kind === 'gateway') return selectProviderConversation(config, rl, id, '__gateway__');
    if (provider.kind !== 'provider') continue;
    return selectProviderConversation(config, rl, id, provider.harness);
  }
}

/**
 * Bind a session to its native agent without asking. A session that already
 * names a provider or account is matched to that agent; a session with no
 * signal picks the first installed terminal harness in catalog tier order. Returns false only when nothing useful is
 * installed, so the caller can surface one line of guidance instead of a picker.
 */
async function autoSelectSessionHarness(id: string): Promise<boolean> {
  const installedCache = new Map<string, boolean>();
  const isInstalled = async (harness?: AiLocalHarnessDefinition): Promise<boolean> => {
    if (!harness) return false;
    const known = installedCache.get(harness.command);
    if (known !== undefined) return known;
    const inspection = await inspectNativeHarness(harness, 1_500);
    installedCache.set(harness.command, inspection.installed);
    return inspection.installed;
  };
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return false;
  if (session.nativeHarness) return true;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const preferred = localHarnessForProvider(session.provider ?? account?.provider ?? '');
  if (preferred && await isInstalled(preferred)) {
    await aiHarnessSelect(preferred.command, id);
    return true;
  }
  const candidates = allLocalHarnesses()
    .filter((harness) => harnessCanRunTurns(harness))
    .sort((left, right) => harnessTierRank(left) - harnessTierRank(right));
  for (const harness of candidates) {
    if (await isInstalled(harness)) {
      await aiHarnessSelect(harness.command, id);
      return true;
    }
  }
  return false;
}

/** Well-known SDK/CLI environment variable names each vendor's own tooling
 * already looks for -- not invented here, just the standard name suggested
 * as a starting point for the env var prompt below. Falls back to a
 * generic <PROVIDER>_API_KEY guess for anything not in this short list. */
const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY', qwen: 'DASHSCOPE_API_KEY',
  kiro: 'KIRO_API_KEY',
  // Confirmed real and current, not guessed: google-antigravity/antigravity-cli
  // issue #632 was closed 2 days before this was written (state_reason:
  // "completed"), with a maintainer's exact working recipe --
  // GEMINI_API_KEY plus modelProvider:"gemini" in the CLI's own
  // settings.json (handled below, in addApiKeyAccount itself, since this
  // map only carries the env var name). Cross-checked against the actual
  // installed binary: modelProvider is a real, present string in it. This
  // matters specifically because it's the only way to authenticate
  // Antigravity CLI that stays inside ClikCode at all -- it has no login
  // subcommand of its own (confirmed via --help), only a full interactive
  // TUI otherwise.
  antigravity: 'GEMINI_API_KEY',
};

async function addApiKeyAccount(rl: HarnessPrompter, harness: AiLocalHarnessDefinition): Promise<string | undefined> {
  const suggested = PROVIDER_API_KEY_ENV[harness.provider] ?? `${harness.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  let entered: string;
  try {
    entered = (await rl.question(`Environment variable holding the key ${chalk.dim(`[${suggested}]`)} › `, [], { cancellable: true })).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_PROMPT_CANCELLED') return undefined;
    throw error;
  }
  const envName = (entered || suggested).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) throw new Error('environment variable name must be letters, numbers, and underscores only');
  if (!process.env[envName]) throw new Error(`${envName} is not set in this shell -- export it first, then try again. ClikCode never asks for or stores the raw key itself, only this reference.`);
  // Antigravity CLI needs one more thing beyond the env var itself: its
  // own settings.json must set modelProvider to "gemini", or it ignores
  // GEMINI_API_KEY entirely and falls back to OAuth (confirmed directly:
  // a maintainer's exact recipe on the now-closed antigravity-cli#632, plus
  // real user reports on #78 of the env var alone having no effect without
  // it). No isolated profile exists for this harness (confirmed: no
  // profileEnv), so this is always the one real, global settings file --
  // merged in, not overwritten, so any of the user's other settings
  // (colorScheme, permissions, trustedWorkspaces, etc.) survive untouched.
  if (harness.command === 'antigravity') {
    const settingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>; } catch { /* no existing settings file yet */ }
    if (settings.modelProvider !== 'gemini') {
      settings.modelProvider = 'gemini';
      await mkdir(join(settingsPath, '..'), { recursive: true });
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    }
  }
  const state = await readState();
  const existingForProvider = state.accounts.filter((account) => account.provider === harness.provider).length;
  const label = `${harness.displayName} (${envName})`;
  const finalLabel = state.accounts.some((account) => account.label === label) ? `${label} ${existingForProvider + 1}` : label;
  await aiAccountAdd({ provider: harness.provider, label: finalLabel, auth: 'api-key', credentialRef: `env:${envName}` });
  return finalLabel;
}

async function addAccountForHarness(rl: HarnessPrompter, harness: AiLocalHarnessDefinition): Promise<string | undefined> {
  // Vendor login is the only path this offered before -- but Claude Code
  // (and others) also declare api-key as a supported local auth kind, with
  // no way to actually set one up short of the fully manual, headless-only
  // `accounts add --auth api-key --credential-ref env:VAR` invocation. Only
  // asks when there's a real choice to make; a harness with just one
  // supported local auth kind skips straight to it, same as before.
  //
  // 'vendor-cli' only counts as a real choice when loginArgv actually
  // exists -- caught during a full audit: localAuth is a broader claim
  // ("this provider conceptually supports vendor-cli auth"), separate from
  // whether this catalog has a scriptable command to perform it. Several
  // harnesses (Aider, Goose, Crush, Factory Droid, Kiro CLI) declare
  // vendor-cli in localAuth with no loginArgv at all -- offering "Vendor
  // login" for those would fall through to aiAccountLogin's own
  // `harness.loginArgv ?? []` default and run the bare binary with no
  // arguments, which isn't a login flow for any of them.
  const choices = harness.localAuth.filter((kind) => (kind === 'vendor-cli' && harness.loginArgv) || kind === 'api-key');
  // Factory Droid and Kiro CLI currently land here: oauth-only in localAuth
  // (no api-key) and no loginArgv either, so there's genuinely no way for
  // this catalog to add an account for them yet -- rather than fabricate a
  // login command that isn't verified, say so plainly instead of silently
  // doing nothing (choices[0] being undefined used to fall through to the
  // same "if (!authKind) return" as a real cancel, indistinguishable from
  // one).
  if (choices.length === 0) throw new Error(`${harness.displayName} doesn't publish a login command or a supported API-key auth mode yet -- nothing here can add an account for it.`);
  const authKind = choices.length > 1
    ? await chooseOption(rl, `Sign in to ${harness.displayName} with`, [
        { label: 'Vendor login', detail: 'opens the CLI’s own sign-in flow', value: 'vendor-cli' as const },
        { label: 'API key', detail: 'reference an environment variable, never typed here', value: 'api-key' as const },
      ])
    : choices[0];
  if (!authKind) return undefined;
  if (authKind === 'api-key') {
    return addApiKeyAccount(rl, harness);
  }
  // No name prompt: aiAccountLogin picks a numbered placeholder up front and
  // replaces it with something derived from the harness's own credentials
  // once login actually completes, wherever that's possible -- one less
  // step than asking the user to type or confirm a name themselves.
  //
  // suspend/resume around this call, previously missing here entirely: the
  // one place aiHarnessSelect's own login flow has always had this, but
  // this second entry point into the exact same loginNativeHarness spawn
  // didn't. Claude Code's own login (print a URL, wait for a pasted code)
  // happens to tolerate running without it, which is why this went
  // unnoticed -- but a harness whose login is a full interactive TUI
  // needing exclusive terminal control (Antigravity CLI's bubbletea, which
  // opens /dev/tty directly) has no business running while ClikCode's own
  // raw-mode/alt-screen state is still active competing for the same
  // terminal.
  let label: string;
  if (harness.loginCapturable && rl instanceof TerminalHarnessPrompter) {
    rl.startWaiting(`signing in to ${harness.displayName}…`);
    try { label = await aiAccountLogin(harness.command); } finally { rl.stopWaiting(); }
  } else if (rl instanceof TerminalHarnessPrompter) {
    await rl.suspend();
    try {
      announceBareInteractiveLogin(harness);
      label = await aiAccountLogin(harness.command);
    } finally { rl.resume(); }
  } else {
    label = await aiAccountLogin(harness.command);
  }
  return label;
}

async function manageAccountAction(rl: HarnessPrompter, accountId: string, action: string): Promise<void> {
  const state = await readState();
  const account = state.accounts.find((item) => item.id === accountId);
  const harness = account ? localHarnessForProvider(account.provider) : undefined;
  if (!account || !harness) return;
  if (action === 'remove') {
    await aiAccountRemove(account.id);
    return;
  }
  if (account.authKind !== 'vendor-cli') return;
  const environment = nativeProfileEnvironment(account.nativeProfile);
  if (action === 'disconnect' && harness.logoutArgv) {
    await runNativeHarnessCommand(harness, harness.logoutArgv, environment);
    account.status = 'needs_login';
    await writeState(state);
  } else if (action === 'reauthenticate' && harness.loginArgv) {
    if (harness.loginCapturable && rl instanceof TerminalHarnessPrompter) {
      rl.startWaiting(`signing in to ${harness.displayName}…`);
      try { await loginNativeHarness(harness, environment); } finally { rl.stopWaiting(); }
    } else if (rl instanceof TerminalHarnessPrompter) {
      await rl.suspend();
      try {
        announceBareInteractiveLogin(harness);
        await loginNativeHarness(harness, environment);
      } finally { await rl.resume(); }
    } else {
      await loginNativeHarness(harness, environment);
    }
    await syncAccountIdentityAfterLogin(harness, account, state);
  }
}


type AdoptableNativeSession = {
  harness: AiLocalHarnessDefinition;
  item: DiscoveredNativeSession;
  accountId?: string;
};

/** Conversations that exist only inside a vendor's own history — never opened
 * through ClikCode — are otherwise invisible in /resume entirely, which only
 * ever looked at ClikCode's own tracked sessions. Two independent mechanisms
 * feed this, because vendors expose their own history in genuinely different
 * ways: a machine-readable CLI listing via discoverArgv (confirmed live:
 * opencode, Hermes; confirmed only against docs/source, not installed here:
 * Qwen Code, Crush; declared but with an unconfirmed JSON shape: Goose,
 * Kilo Code; a real command with no JSON mode at all, needing its own
 * numbered-list parser: Gemini CLI) — or, for harnesses that publish no
 * listing command whatsoever, reading their own on-disk session files
 * directly (confirmed live: Claude Code, Codex, Cursor Agent; docs-only,
 * unverified against a real install: Pi). GitHub Copilot CLI, Aider, Amp,
 * Factory Droid, Kiro CLI, Cline CLI, and Command Code are deliberately not
 * wired in at all: each either has no local listing mechanism (Aider, Amp's
 * canonical store is server-side), an undocumented on-disk format (Copilot
 * CLI, Factory Droid, Kiro CLI, Cline CLI), or an unresolved identity
 * mismatch between this catalog's entry and the only public docs found for
 * its name (Command Code) — none of these are guessed at.
 *
 * Every one of those spawns a real vendor CLI (up to a 4s timeout each, once
 * per account profile) or walks a vendor's on-disk store, so this is slower
 * than the rest of /resume by orders of magnitude and must never be awaited
 * before the picker is on screen. */
async function discoverAdoptableSessions(state: HarnessState, workspace: string): Promise<AdoptableNativeSession[]> {
  const discoveryProfiles = (harness: AiLocalHarnessDefinition): Array<AiHarnessAccount | undefined> => {
    const accounts = state.accounts.filter((item) => item.provider === harness.provider && item.status === 'ready');
    if (!accounts.length) return [undefined];
    const unique = new Map<string, AiHarnessAccount>();
    for (const account of accounts) unique.set(account.nativeProfile?.path ?? 'default', account);
    return [...unique.values()];
  };
  const discoverable = allLocalHarnesses().filter((harness) => harness.session?.discoverArgv);
  const shellDiscovered = (await Promise.all(discoverable.map(async (harness) => {
    return (await Promise.all(discoveryProfiles(harness).map(async (account) => {
      const environment = nativeProfileEnvironment(account?.nativeProfile);
      const found = await discoverNativeSessions(harness, environment, workspace);
      return found.map((item) => ({ harness, item, accountId: account?.id }));
    }))).flat();
  }))).flat();
  const fsDiscovered = (await Promise.all(Object.entries(FS_SESSION_DISCOVERY).map(async ([command, discover]) => {
    const harness = localHarnessForCommand(command);
    if (!harness) return [];
    const inspection = await inspectNativeHarness(harness, 500);
    if (!inspection.installed) return [];
    return (await Promise.all(discoveryProfiles(harness).map(async (account) => {
      const found = await discover(workspace, nativeProfileEnvironment(account?.nativeProfile)).catch(() => []);
      return found.map((item) => ({ harness, item, accountId: account?.id }));
    }))).flat();
  }))).flat();
  return [...shellDiscovered, ...fsDiscovered]
    .filter(({ harness, item, accountId }) => !state.sessions.some((session) => session.nativeHarness === harness.command
      && session.nativeSessionId === item.nativeId && (!accountId || session.accountId === accountId)));
}

/** Indirection so tests can hold discovery open and observe the picker while
 * it is still pending. */
export const NATIVE_SESSION_DISCOVERY = { run: discoverAdoptableSessions };

const NATIVE_DISCOVERY_TTL_MS = 60_000;
let nativeDiscoveryCache: { key: string; at: number; result: Promise<AdoptableNativeSession[]> } | undefined;

export function resetNativeDiscoveryCache(): void {
  nativeDiscoveryCache = undefined;
}

/** Reopening /resume inside one terminal re-spawned every installed vendor CLI
 * from scratch. The listing does not change meaningfully minute to minute, so
 * hold it briefly — keyed on the inputs that would change the answer. */
function cachedAdoptableSessions(state: HarnessState, workspace: string): Promise<AdoptableNativeSession[]> {
  const key = [workspace, ...state.accounts.map((item) => `${item.id}:${item.nativeProfile?.path ?? ''}`).sort()].join('\u0000');
  const cached = nativeDiscoveryCache;
  if (cached && cached.key === key && Date.now() - cached.at < NATIVE_DISCOVERY_TTL_MS) return cached.result;
  const result = NATIVE_SESSION_DISCOVERY.run(state, workspace).catch(() => {
    // fail-open-ok: discovery is passive enrichment of a list that is already
    // complete for ClikCode's own conversations. A vendor CLI that fails must
    // not take /resume down with it, and must not be cached as an answer.
    nativeDiscoveryCache = undefined;
    return [] as AdoptableNativeSession[];
  });
  nativeDiscoveryCache = { key, at: Date.now(), result };
  return result;
}

/** Selected while discovery is still running: wait for it, then reopen. */
const PENDING_DISCOVERY_VALUE = '__discovering__';

export async function interactiveSessionPicker(rl: HarnessPrompter, currentId: string): Promise<{ id: string } | undefined> {
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  // A session with no turns yet has nothing to resume into — showing it here is
  // indistinguishable from a real conversation until you're already inside it,
  // and older empty sessions (from before aiSessionClose started dropping them)
  // otherwise bury every real, titled conversation under identical
  // "Untitled chat" entries. Always keep the current session visible even if
  // it's still empty, so picking "current" back out of the list still works.
  // A set nativeSessionId counts as real content too, even with zero
  // ClikCode-tracked messages: a session adopted from a vendor's own history,
  // or linked to one directly, has a real vendor-side conversation behind it
  // that ClikCode simply never routed a turn through yet.
  // A conversation another terminal is driving right now used to be dropped
  // from this list outright, on the theory that both terminals would then
  // render and steer the same chat. In practice a claim's heartbeat only
  // proves its process is still running, not that anyone is still watching
  // it -- ai.ts ignores SIGHUP for the whole session lifetime so a flaky SSH
  // connection survives it, which means a dropped connection (closing the
  // laptop, a network blip, never sending /exit) leaves an orphaned process
  // heartbeating forever. That silently hid the conversation from every
  // future /resume, indistinguishable from data loss. It is listed and
  // annotated instead below; selecting it takes it over the same way opening
  // any session already does (claimSession is unconditional).
  const sessions = state.sessions
    .filter((session) => session.id === currentId || sessionTranscriptMessages(session).length > 0 || Boolean(session.nativeSessionId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const workspace = current?.workspace ?? process.cwd();

  // ClikCode's own conversations are already in hand and are what /resume is
  // almost always for, so the picker opens on them immediately. Vendor
  // discovery folds in when it lands, through the same refresh mechanism the
  // account picker uses for usage. Awaiting it first left the composer cleared
  // and the screen blank for as long as the slowest vendor CLI took to answer.
  let discovered: AdoptableNativeSession[] = [];
  let discovering = true;
  const discovery = cachedAdoptableSessions(state, workspace)
    .then((found) => { discovered = found; })
    .finally(() => { discovering = false; });

  const buildOptions = (): PickerOption<string>[] => {
    // Every option gets a single real recency key so the newest conversation is
    // always near the top regardless of which source found it — grouping by
    // source first (every ClikCode session, then every opencode result, then
    // every Hermes result, ...) buried a two-minutes-old live Claude Code
    // session below Hermes entries from June, since each *group* was sorted
    // internally but the groups themselves were never interleaved. A source
    // with no real timestamp (an unparsed vendor display string) sorts last
    // rather than claiming a false position.
    const groupedOptions = sessionPickerOptions(sessions, currentId);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const trackedBlocks = new Map<string, { sortKey: number; options: PickerOption<string>[] }>();
    for (const option of groupedOptions) {
      const session = sessionsById.get(option.value)!;
      if (session.id !== currentId && sessionClaimIsLive(session)) {
        option.detail = `${option.detail ?? ''} · active in another terminal`;
      }
      const root = conversationIdFor(session);
      const updatedAt = Date.parse(session.updatedAt);
      const block = trackedBlocks.get(root) ?? { sortKey: -Infinity, options: [] };
      block.sortKey = Math.max(block.sortKey, Number.isNaN(updatedAt) ? -Infinity : updatedAt);
      block.options.push(option);
      trackedBlocks.set(root, block);
    }
    const optionBlocks = [
      ...trackedBlocks.values(),
      ...discovered.map(({ harness, item, accountId }, index) => ({
        sortKey: item.updatedAtMs ?? -Infinity,
        options: [{
          label: `${harness.displayName} • ${item.title ?? 'Untitled chat'}`,
          detail: `· not yet in ClikCode${accountId ? ` · ${state.accounts.find((account) => account.id === accountId)?.label ?? 'linked account'}` : ''}${item.updatedAt ? ` · ${item.updatedAt}` : ''}`,
          value: `native:${index}`,
        }],
      })),
    ].sort((left, right) => right.sortKey - left.sortKey);
    // Conversation roots and unadopted native sessions share one recency order.
    // Provider hops stay behind each root row's Tab history.
    const options = optionBlocks.flatMap((block) => block.options);
    if (discovering) {
      options.push({
        label: 'Looking for chats from other CLIs…',
        detail: '· your ClikCode conversations are listed above',
        value: PENDING_DISCOVERY_VALUE,
      });
    }
    return options;
  };

  const selected = await chooseOption(rl, 'Resume a session', buildOptions(), undefined,
    { refreshedOptions: buildOptions, refresh: discovery });
  if (!selected) return undefined;
  if (selected === PENDING_DISCOVERY_VALUE) {
    await discovery;
    return interactiveSessionPicker(rl, currentId);
  }
  if (!selected.startsWith('native:')) return { id: selected };
  const match = discovered[Number.parseInt(selected.slice('native:'.length), 10)];
  if (!match) return undefined;
  const nativeId = match.item.nativeId;
  const account = match.accountId
    ? state.accounts.find((item) => item.id === match.accountId)
    : state.accounts.find((item) => item.provider === match.harness.provider && item.status === 'ready');
  const defaults = resolveDefaultSettings(state, match.harness.provider);
  const now = new Date().toISOString();
  // The vendor's own thread already has full context regardless — adopting
  // its identity alone is enough for continuation to work correctly the
  // moment a turn is sent. Populating ClikCode's own transcript view too is a
  // separate, best-effort read: only wired for the harnesses with a confirmed
  // way to read a whole conversation back out (see ADOPTED_TRANSCRIPT_READERS
  // above), and never something continuation itself depends on.
  const transcriptReader = ADOPTED_TRANSCRIPT_READERS[match.harness.command];
  const messages = transcriptReader
    ? await transcriptReader(match.harness, nativeId, workspace, nativeProfileEnvironment(account?.nativeProfile)).catch(() => [])
    : [];
  const id = randomUUID();
  const adopted: HarnessSession = {
    id, conversationId: id, route: 'local', accountId: account?.id ?? null, provider: match.harness.provider,
    model: null, effort: defaults.effort, permissionMode: defaults.permissionMode, accountFailover: defaults.accountFailover,
    createdAt: now, updatedAt: now, status: 'active',
    nativeHarness: match.harness.command, nativeSessionId: nativeId, nativeStartedAt: now,
    workspace, name: match.item.title, ...(messages.length ? { messages } : {}),
  };
  state.sessions.push(adopted);
  await writeState(state);
  // Picking a specific vendor's own chat by name is an explicit choice to open
  // it as that vendor — forcing it onto whatever provider was already active
  // (the same-conversation /resume behavior below) would immediately discard
  // the native session id just adopted, undoing the entire point of listing it.
  return { id: adopted.id };
}

async function interactiveModelPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
    : session.provider ? localHarnessForProvider(session.provider) : undefined;
  const catalog = harness ? nativeModelCatalogForPicker(harness, account) : { models: account?.models ?? [] };
  const effective = session.model ?? catalog.configured;
  const discoveredModels = [...catalog.models].sort((left, right) => left === effective ? -1 : right === effective ? 1 : left.localeCompare(right));
  const options: PickerOption<string>[] = [
    ...discoveredModels.map((model) => {
      const parts = [
        catalog.labels?.[model],
        model === effective ? 'current' : undefined,
        model === effective && !session.model && model === catalog.configured ? 'provider configured' : undefined,
      ].filter((part): part is string => Boolean(part));
      return { label: model, detail: parts.length ? `· ${parts.join(' · ')}` : undefined, value: model };
    }),
    { label: 'Automatic provider default', detail: effective ? undefined : '· current', value: 'default' },
    { label: 'Enter a model ID…', value: '__custom__' },
  ];
  const selected = await chooseOption(rl, 'Choose a model', options);
  if (!selected) return;
  const value = selected === '__custom__' ? (await rl.question('Model ID › ')).trim() : selected;
  // Applies to this chat only, no further "apply to" step: a model choice is
  // read as a per-conversation decision, unlike effort/permissions/failover,
  // which are more often "how I always want this provider to behave" and
  // genuinely benefit from a scope choice.
  if (value) await aiSessionCommand(id, `/model ${value}`);
}

async function interactiveSessionManager(rl: HarnessPrompter, id: string): Promise<'resume' | 'new' | 'exit' | undefined> {
  const action = await chooseOption(rl, 'Conversations', [
    { label: 'Resume another…', value: 'resume' },
    { label: 'Start clean', detail: 'reset provider context', value: 'new' },
    { label: 'Rename', value: 'rename' },
    { label: 'Fork', detail: 'copy transcript into a new conversation', value: 'fork' },
    { label: 'Archive', value: 'archive' },
    { label: 'Delete', detail: 'remove local ClikCode history', value: 'delete' },
  ] as const);
  if (!action) return undefined;
  if (action === 'resume') return 'resume';
  if (action === 'new') return 'new';
  if (action === 'rename') {
    const name = (await rl.question('Conversation name › ')).trim();
    if (name) await aiSessionCommand(id, `/rename ${name}`);
    return undefined;
  }
  if (action === 'fork') { await aiSessionCommand(id, '/fork'); return undefined; }
  if (action === 'archive') {
    const answer = (await rl.question('Archive this conversation? [y/N] › ')).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') { await aiSessionCommand(id, '/archive'); return 'exit'; }
    return undefined;
  }
  const answer = (await rl.question('Delete this conversation from ClikCode? Type delete › ')).trim().toLowerCase();
  if (answer === 'delete') { await aiSessionCommand(id, '/delete confirm'); return 'exit'; }
  return undefined;
}

/** After picking a new value, ask what it applies to instead of making that a
 * separate "Defaults for new chats" menu that asks the same question about the
 * same settings a second time. One flow per setting: choose the value, then
 * choose the scope. */
async function applySettingScope(
  rl: HarnessPrompter, id: string, key: 'effort' | 'permissions' | 'failover' | 'model', value: string,
): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  const harness = session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const scope = await chooseOption(rl, 'Apply to', [
    { label: 'This chat only', value: 'session' as const },
    { label: 'Global default', detail: 'every provider, unless overridden', value: 'global' as const },
    ...(harness ? [{ label: `${harness.displayName} default`, detail: 'this provider only', value: 'provider' as const }] : []),
  ]);
  if (!scope) return;
  if (scope === 'session') {
    if (key === 'failover') await aiSessionCommand(id, `/accounts failover ${value}`);
    else await aiSessionCommand(id, `/${key} ${value}`);
  } else if (scope === 'global') {
    await aiSettingsSetGlobal(key, value);
  } else if (harness) {
    await aiSettingsSetProvider(harness.command, key, value);
  }
}

async function interactiveEffortPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway reasoning effort is selected by platform routing policy.');
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (harness && !harnessSupportsEffort(harness)) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag.`);
  const effortOption = harness ? optionForHarness(harness, 'effort') : undefined;
  const efforts = effortOption?.values?.length ? effortOption.values : VALID_EFFORTS;
  const selected = await chooseOption(rl, 'Choose reasoning effort', efforts.map((value) => ({
    label: value, detail: value === session.effort ? '· current' : undefined, value,
  })));
  if (selected) await applySettingScope(rl, id, 'effort', selected);
}

async function interactiveHarnessOptionPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (!harness) throw new Error('Choose a provider first.');
  const manifest = localHarnessCapabilityManifest(harness);
  // Only what no ClikCode command already owns. /model, /permissions, /effort,
  // /cwd and /add-dir were each listed here as a raw vendor row as well, so the
  // same setting had two interfaces that could disagree.
  const option = await chooseOption(rl, `${harness.displayName} options`, vendorFacingOptions(manifest.options).map((item) => ({
    label: item.label,
    detail: `· ${item.description}${item.dangerous ? ` · ${chalk.yellow('dangerous')}` : ''}`,
    value: item,
  })));
  if (!option) return;
  let raw: string | undefined;
  if (option.kind === 'boolean') {
    raw = await chooseOption(rl, option.label, [
      { label: 'On', value: 'on' }, { label: 'Off', value: 'off' },
    ]);
  } else if (option.values?.length) {
    raw = await chooseOption(rl, option.label, option.values.map((entry) => ({ label: entry, value: entry })));
  } else {
    raw = (await rl.question(`${option.label} › `)).trim();
  }
  if (raw === undefined || raw === '') return;
  const fresh = await readState();
  const target = fresh.sessions.find((item) => item.id === id);
  if (!target) return;
  setSessionHarnessOption(target, harness, option.id, raw);
  target.updatedAt = new Date().toISOString();
  await writeState(fresh);
}

async function interactivePermissionPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway permissions are enforced by authenticated platform policy.');
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const current = session.permissionMode ?? 'ask';
  const descriptions: Record<AiHarnessPermissionMode, string> = {
    ask: 'require approval; unanswered headless prompts are denied',
    bypass: 'run without approval prompts',
    auto: 'provider reviews approval requests automatically',
  };
  const supported = harness ? VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode)) : VALID_PERMISSION_MODES;
  if (!supported.length) throw new Error(`${harness?.displayName ?? 'This provider'} does not map ClikCode's permission modes to a real flag.`);
  const selected = await chooseOption(rl, 'Choose permissions', supported.map((value) => ({
    label: value[0].toUpperCase() + value.slice(1), detail: `· ${descriptions[value]}${value === current ? ' · current' : ''}`, value,
  })));
  if (selected) await applySettingScope(rl, id, 'permissions', selected);
}

async function interactiveFailoverPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const current = session.accountFailover ?? 'on-quota-exhausted';
  const selected = await chooseOption(rl, 'Quota failover', [
    { label: 'Auto-switch accounts', detail: `· switch to another ready account of the same provider when quota runs out${current === 'on-quota-exhausted' ? ' · current' : ''}`, value: 'auto' },
    { label: 'Never', detail: `· stop and ask instead of switching${current === 'never' ? ' · current' : ''}`, value: 'never' },
  ]);
  if (selected) await applySettingScope(rl, id, 'failover', selected);
}

async function interactiveSettingsPicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  const harness = session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const selected = await chooseOption(rl, 'Settings', [
    { label: 'Provider & account', detail: 'choose a harness, login, or add an account', value: 'provider' },
    ...(harness?.modelArgvPrefix ? [{ label: 'Model', detail: 'provider default or model ID', value: 'model' }] : []),
    ...(harness && harnessSupportsEffort(harness) ? [{ label: 'Reasoning effort', detail: 'provider-supported levels', value: 'effort' }] : []),
    ...(harness?.permissionModes?.length ? [{ label: 'Permissions', detail: 'provider-supported approval behavior', value: 'permissions' }] : []),
    ...(harness && vendorFacingOptions(localHarnessCapabilityManifest(harness).options).length
      ? [{ label: `${harness.displayName} options`, detail: 'modes, tools, safety, and context', value: 'options' }] : []),
    { label: 'Quota failover', detail: 'switch accounts automatically, or not', value: 'failover' },
    { label: 'Show current setup', value: 'status' },
  ] as const);
  if (selected === 'provider') return interactiveEnginePicker(config, rl, id);
  else if (selected === 'model') await interactiveModelPicker(rl, id);
  else if (selected === 'effort') await interactiveEffortPicker(rl, id);
  else if (selected === 'permissions') await interactivePermissionPicker(rl, id);
  else if (selected === 'options') await interactiveHarnessOptionPicker(rl, id);
  else if (selected === 'failover') await interactiveFailoverPicker(rl, id);
  else if (selected === 'status') await aiSessionCommand(id, '/status');
  return undefined;
}

/** Persistent terminal session using the same command and routing surface as automation. */
/** Commands the interactive loop handles itself (pickers, prompts, turns with
 * the waiting UI). Every other registry command falls through to
 * HEADLESS_SLASH_HANDLERS with its output shown in a panel. */
export const INTERACTIVE_SLASH_HANDLER_KEYS = [
  'exit', 'new', 'redraw', 'provider', 'account', 'accounts', 'model', 'effort', 'permissions', 'options', 'capabilities',
  'settings', 'sessions', 'resume', 'rename', 'archive', 'delete', 'mention', 'review', 'init', 'native', 'compact',
  'export', 'memory', 'doctor', 'login', 'logout',
] as const satisfies readonly SlashHandlerKey[];
type InteractiveSlashHandlerKey = typeof INTERACTIVE_SLASH_HANDLER_KEYS[number];
interface InteractiveSlashOutcome {
  /** Adopt this session (a new conversation, a handoff branch, a resumed chat). */
  id?: string;
  exit?: boolean;
  notice?: string;
  /** Run this as a turn on the (possibly just adopted) session. */
  prompt?: string;
  echo?: boolean;
}

/** Human-readable health summary for the TUI (the headless /doctor is JSON). */
async function doctorSummary(state: HarnessState): Promise<string> {
  const harnesses = allLocalHarnesses().filter((harness) => harnessCanRunTurns(harness));
  const inspections = await Promise.all(harnesses.map(async (harness) => ({ harness, inspection: await inspectNativeHarnessForPicker(harness) })));
  const installed = inspections.filter((item) => item.inspection.installed);
  return [
    `Installed harnesses (${installed.length}/${inspections.length})`,
    ...installed.map(({ harness, inspection }) => `  ${harness.displayName}${inspection.version ? ` ${inspection.version}` : ''} · ${integrationLabel(harness)}`),
    '',
    `Accounts (${state.accounts.length})`,
    ...(state.accounts.length ? state.accounts.map((account) => `  ${account.label} · ${account.provider} · ${account.status}${account.quotaState === 'exhausted' ? ' · quota exhausted' : ''}`) : ['  none yet — /provider adds one']),
    '',
    `State: ${compactPath(harnessStatePath())}`,
  ].join('\n');
}

export async function aiSessionInteractive(config: Conf, id: string): Promise<void> {
  // A long-lived interactive session should survive a transient terminal
  // hangup (a flaky/mobile SSH connection dropping and reconnecting mid-use
  // is exactly the kind of thing this hits), not die from it. Node's
  // default action for an unhandled SIGHUP is immediate termination --
  // before any try/catch, before uncaughtException, before anything this
  // process could do about it. run()'s own SIGHUP forwarding only covers
  // the narrow window a login/turn subprocess is actually running; a
  // hangup arriving in any of the gaps around that (mid-suspend, during
  // identity derivation, mid-render) previously killed the whole process
  // silently -- explaining a real, reproduced case where the account never
  // saved because ClikCode itself was gone, with no crash log at all
  // (SIGHUP's default handling pre-empts JS entirely; there was nothing
  // for a crash handler to catch). Ignoring it here covers the session's
  // entire lifetime, not just subprocess windows. SIGINT gets the identical
  // treatment for a related but distinct reason: run()'s own Ctrl+C
  // forwarding to a login/turn subprocess is removed the INSTANT that
  // subprocess exits -- but the terminal stays in cooked mode (raw mode
  // off, from suspend()) for everything that happens after, including this
  // codebase's own identity-derivation retry loop, which can legitimately
  // run for several seconds with nothing visibly changing on screen. A
  // Ctrl+C landing in that specific gap -- a completely natural thing to do
  // when the screen looks idle right after pasting an auth code --
  // previously had no handler registered at all, so Node's default SIGINT
  // action (immediate termination) applied, killing the process mid-save.
  // While raw mode IS active (the normal composer state), Ctrl+C is read
  // as data (byte 0x03) handled entirely inside this UI, never reaching
  // the OS as a real signal at all -- so ignoring the signal here changes
  // nothing about that existing, working "cancel the current turn"
  // behavior; it only closes the gap where raw mode is temporarily off and
  // nothing else is watching. /exit and /quit remain the ways to leave.
  const ignoreHangup = (): void => {};
  const ignoreInterrupt = (): void => {};
  if (process.platform !== 'win32') process.on('SIGHUP', ignoreHangup);
  process.on('SIGINT', ignoreInterrupt);
  try {
    await aiSessionInteractiveInner(config, id);
  } finally {
    if (process.platform !== 'win32') process.off('SIGHUP', ignoreHangup);
    process.off('SIGINT', ignoreInterrupt);
  }
}

async function aiSessionInteractiveInner(config: Conf, id: string): Promise<void> {
  // Reassigned whenever a nested flow writes its own state: `session` must stay
  // a member of whichever snapshot we later hand to writeState, or that write
  // both reverts the nested flow's work and drops our own edits.
  let state = await readState();
  let session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (await synchronizeNativeTranscript(state, session)) await writeState(state);
  // Palette rows come from the ONE slash registry (with argHint/group).
  // slashPalette itself leaves out everything the vendor harness owns -- its
  // manager commands, whatever an ACP agent advertised, and the `/<harness>`
  // switch rows -- so what the palette shows is ClikCode's own commands plus
  // the user's custom templates, never the terminal CLI's list mixed in.
  const slashCommandsFor = (target: HarnessSession): PickerOption<string>[] => {
    const harness = sessionHarness(target);
    return slashPalette(target, harness, slashExtrasFor(target, harness));
  };
  // Created before auto-select so a first-ever install/sign-in — the most
  // common time either is actually needed — has somewhere to show its
  // "installing…" spinner and a real terminal to suspend into for a vendor
  // login prompt, instead of running headless before the UI exists.
  const rl: HarnessPrompter = terminalUiSupported()
    ? new TerminalHarnessPrompter()
    : createInterface({
      input, output, terminal: false, historySize: 1_000, removeHistoryDuplicates: true,
      completer: (value: string) => {
        const fallbackCommands = slashCommandsFor(session!).map((item) => item.value);
        const matches = fallbackCommands.filter((command) => command.startsWith(value));
        return [matches.length ? matches : fallbackCommands, value] as [string[], string];
      },
    });
  if (rl instanceof TerminalHarnessPrompter) activeTerminalHarness = rl;
  rl.render?.(session);
  if (!session.nativeHarness && session.route !== 'gateway') {
    const auto = await autoSelectSessionHarness(id);
    if (!auto) {
      const selected = await interactiveEnginePicker(config, rl, id);
      if (!selected) return;
      if (selected !== id) id = selected;
    }
    // The picker and auto-select each ran their own read/write cycle, so the
    // snapshot above is stale. Adopt the current one wholesale.
    state = await readState();
    const next = state.sessions.find((item) => item.id === id);
    if (!next) return;
    session = next;
  }
  let stateChanged = false;
  if (session.status !== 'active') {
    session.status = 'active';
    session.closedAt = undefined;
    session.updatedAt = new Date().toISOString();
    stateChanged = true;
  }
  if (!session.model) {
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
      : session.provider ? localHarnessForProvider(session.provider) : undefined;
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
    if (harness) {
      const catalog = await nativeModelCatalog(harness, account);
      if (catalog.configured) {
        session.model = catalog.configured;
        session.updatedAt = new Date().toISOString();
        stateChanged = true;
      }
    }
  }
  // Take ownership before the first paint so a terminal opened a moment later
  // skips this conversation instead of attaching to it.
  claimSession(session);
  stateChanged = true;
  if (stateChanged) await writeState(state);
  const initialAccount = session.accountId ? state.accounts.find((account) => account.id === session.accountId)?.label : undefined;
  if (rl.render) rl.render(session, initialAccount);
  else emitHarnessOutput({ status: 'ready', session, account: initialAccount });
  const refreshUsage = (target: HarnessSession, targetState: HarnessState): void => {
    if (!(rl instanceof TerminalHarnessPrompter)) return;
    void nativeUsageReading(target, targetState).then((reading) => {
      if (activeTerminalHarness === rl) rl.usage(reading?.label, usageResetLabel(reading?.windows));
    }).catch(() => { /* Usage is optional provider metadata. */ });
  };
  refreshUsage(session, state);
  // Without this, usage only ever refreshed at session-open and right after
  // each submitted message -- fine for a quick back-and-forth, but a long
  // turn or an idle stretch between messages left the number sitting there
  // stale for however long that gap was, well past nativeUsageReading's own
  // 30s cache window (which bounds *how often this can update*, not
  // *whether anything ever asks it to*). This is what actually asks.
  const claimInterval = setInterval(() => {
    void refreshSessionClaim(id).catch(() => undefined);
  }, Math.floor(SESSION_CLAIM_TTL_MS / 3));
  claimInterval.unref();
  const usageInterval = rl instanceof TerminalHarnessPrompter ? setInterval(() => {
    void readState().then((latestState) => {
      const latest = latestState.sessions.find((item) => item.id === id);
      if (latest) refreshUsage(latest, latestState);
    }).catch(() => { /* Usage is optional provider metadata. */ });
    // Half the usage window, so every other tick finds the reading expired and
    // refreshes it. A tick longer than the window would land inside it and
    // silently halve the real refresh rate.
  }, 15_000) : undefined;
  let notice: string | undefined;
  let synchronizedSessionId = id;
  let transportSessionId = id;
  try {
    while (true) {
      let line: string;
      let queuedTurnId: string | undefined;
      let activeWorkspace = process.cwd();
      // One live Codex/ACP child per OPEN conversation: leaving it (new chat,
      // handoff, resume) closes the child it had.
      if (transportSessionId !== id) {
        await closePersistentTransport(transportSessionId);
        nativeAvailableCommands.delete(transportSessionId);
        transportSessionId = id;
      }
      try {
        const latestState = await readState();
        const latest = latestState.sessions.find((item) => item.id === id);
        if (!latest) break;
        activeWorkspace = latest.workspace ?? process.cwd();
        if (synchronizedSessionId !== id) {
          if (await synchronizeNativeTranscript(latestState, latest)) await writeState(latestState);
          synchronizedSessionId = id;
        }
        const account = latest.accountId ? latestState.accounts.find((item) => item.id === latest.accountId)?.label : undefined;
        rl.render?.(latest, account, notice);
        refreshUsage(latest, latestState);
        notice = undefined;
        const queued = latest.queuedTurns?.[0];
        if (queued) {
          // No notice: a queued message is echoed into the conversation as the
          // user message it is, and the waiting row underneath says a turn is
          // running. Announcing it a third time said nothing the screen did
          // not already say.
          line = queued.text;
          queuedTurnId = queued.id;
        } else line = (await rl.question('› ', slashCommandsFor(latest), { rightArrowPalette: true })).trim();
      } catch (error) {
        // A non-interactive caller may close stdin after its final command.
        // Treat that exactly like leaving the foreground harness, not a crash.
        if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') break;
        throw error;
      }
      if (!line) continue;
      let interruptedSubmission: { text: string; restoreOnEscape: boolean } | undefined;
      /** One turn with the normal waiting / cancel / live-input UI. `echo`
       * paints the submitted text as the pending user message; synthetic
       * prompts (/review, /init, /compact) are not shown as if typed. */
      const runInteractiveTurn = async (targetId: string, promptText: string, turn: { echo: boolean; queuedTurnId?: string }): Promise<void> => {
        const activeState = await readState();
        const active = activeState.sessions.find((item) => item.id === targetId);
        const activeAccount = active?.accountId ? activeState.accounts.find((item) => item.id === active.accountId)?.label : undefined;
        const run = { persistentTransports: true, ...(turn.queuedTurnId ? { queuedTurnId: turn.queuedTurnId } : {}) };
        if (active && rl.render) {
          const pending: HarnessSession = {
            ...active,
            messages: [...sessionTranscriptMessages(active), ...(turn.echo ? [{ role: 'user' as const, content: promptText }] : [])].slice(-40),
            pendingTurn: undefined,
            ...(turn.queuedTurnId
              ? { queuedTurns: active.queuedTurns?.filter((item) => item.id !== turn.queuedTurnId) }
              : {}),
          };
          rl.render(pending, activeAccount);
          const turnController = new AbortController();
          const liveInput = new LiveTurnInputBroker();
          interruptedSubmission = { text: promptText, restoreOnEscape: false };
          activeTerminalHarness?.startWaiting('thinking', (restoreDraft) => {
            interruptedSubmission!.restoreOnEscape = restoreDraft && turn.echo;
            turnController.abort();
          }, (text) => liveInput.submit(text));
          try { await aiGatewaySessionSend(config, targetId, promptText, turnController.signal, { ...run, liveInput }); }
          finally {
            liveInput.close();
            await activeTerminalHarness?.flushWaitingSubmissions();
            activeTerminalHarness?.stopWaiting();
          }
          return;
        }
        output.write(`${chalk.dim(`${active ? sessionProviderLabel(active) : 'Provider'} · working…`)}\n`);
        try { await aiGatewaySessionSend(config, targetId, promptText, undefined, run); }
        finally { activeTerminalHarness?.stopWaiting(); }
      };
      /** A subprocess the user has to wait for gets the same waiting indicator a turn does. */
      const withWaiting = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
        if (!(rl instanceof TerminalHarnessPrompter)) return work();
        rl.startWaiting(label);
        try { return await work(); } finally { rl.stopWaiting(); }
      };
      const pause = async (): Promise<void> => { if (rl.render) await rl.question('Press Enter to return › '); };
      /** The headless handler, with its output in a panel; pauses when one was shown. */
      const viaHeadless = async (text: string): Promise<InteractiveSlashOutcome> => {
        const before = panelsShown;
        const resulting = await aiSessionCommand(id, text);
        if (panelsShown > before) await pause();
        return resulting !== id ? { id: resulting } : {};
      };
      try {
        // A queued live-composer submission is always conversation text. A
        // leading slash or path in it must not turn into a local command when
        // it is automatically dispatched after the active turn.
        if (queuedTurnId) {
          await runInteractiveTurn(id, line, { echo: true, queuedTurnId });
          continue;
        }
        const standaloneAttachment = await resolveStandaloneAttachment(line, activeWorkspace);
        if (standaloneAttachment) {
          const attachmentState = await readState();
          const attachmentSession = attachmentState.sessions.find((item) => item.id === id);
          if (!attachmentSession) throw new Error(`AI session "${id}" was not found`);
          await queueAttachment(attachmentSession, standaloneAttachment);
          attachmentSession.updatedAt = new Date().toISOString();
          await writeState(attachmentState);
          notice = `Attached ${compactPath(standaloneAttachment)} for the next request`;
          if (!rl.render) emitHarnessOutput({ panel: 'attachments', attachments: attachmentSession.attachments ?? [] });
          continue;
        }
        const commandState = await readState();
        const commandSession = commandState.sessions.find((item) => item.id === id);
        if (!commandSession) break;
        const commandHarness = sessionHarness(commandSession);
        // `/etc/hosts explain this` is a request about a file, not a command.
        const route = routeSlashInput(line, slashRouteContextFor(commandSession, commandHarness, (path) => existsSync(expandHomePath(path))));
        let outcome: InteractiveSlashOutcome = {};
        if (route.kind === 'prompt') outcome = { prompt: route.prompt, echo: true };
        else if (route.kind === 'native') {
          if (commandSession.route === 'gateway') throw new Error('Native harness commands apply only to local harnesses.');
          outcome = { prompt: route.prompt, echo: true };
        }
        else if (route.kind === 'unknown') throw new Error(unknownSlashMessage(route));
        else if (route.kind === 'custom') {
          const custom = customCommandsFor(commandSession, commandHarness).find((item) => item.name === route.name);
          if (!custom) throw new Error(`custom command /${route.name} is no longer available`);
          outcome = { prompt: customCommandPrompt(custom, route.args, commandHarness), echo: false };
        }
        else if (route.kind === 'harness') {
          // `/<harness> [request]`: hand off, ADOPT the resulting session, and
          // run the request here with the normal waiting UI -- it used to run
          // headless on a branch this loop never switched to.
          const selected = await newProviderConversation(id, route.command);
          outcome = { id: selected, ...(route.args ? { prompt: route.args, echo: true } : {}) };
        }
        else if (route.kind === 'manager') {
          const manager = commandHarness ? (localHarnessCapabilityManifest(commandHarness).managers as Record<string, { label: string; listArgv?: readonly string[]; manageArgv?: readonly string[] } | undefined> | undefined)?.[route.name] : undefined;
          if (!commandHarness || !manager) throw new Error('Choose a provider first.');
          if (manager.listArgv) {
            const listing = await withWaiting(`loading ${manager.label}…`, () => nativeManagerListing(commandState, commandSession, route.name));
            rl.panel?.(listing.label, listing.text);
            if (!rl.panel) emitHarnessOutput({ panel: route.name, text: `${listing.label}\n\n${listing.text}` });
            await pause();
          } else if (manager.manageArgv && rl instanceof TerminalHarnessPrompter) {
            const selectedAccount = commandSession.accountId ? commandState.accounts.find((item) => item.id === commandSession.accountId) : undefined;
            await rl.suspend();
            try { await runNativeHarnessCommand(commandHarness, manager.manageArgv, turnEnvironment(commandHarness, selectedAccount)); }
            finally { rl.resume(); }
          } else throw new Error(`${commandHarness.displayName} requires an interactive terminal for ${manager.label}.`);
        }
        else {
          // Availability is decided BEFORE any picker opens, so `/model` on a
          // harness without a model selector says so instead of offering a list.
          const availability = route.entry.availability(commandSession, commandHarness);
          if (!availability.available) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
          const text = `/${route.entry.name}${route.args ? ` ${route.args}` : ''}`;
          const { args } = route;
          const interactive: Record<InteractiveSlashHandlerKey, () => Promise<InteractiveSlashOutcome | void>> = {
            exit: async () => { await aiSessionLeave(id); return { exit: true }; },
            new: async () => ({ id: await newConversation(id), ...(args ? { prompt: args, echo: true } : {}) }),
            redraw: async () => { rl.render?.(commandSession, commandSession.accountId ? commandState.accounts.find((item) => item.id === commandSession.accountId)?.label : undefined); },
            provider: async () => ({ id: await interactiveEnginePicker(config, rl, id) ?? id }),
            account: async () => args ? viaHeadless(text) : { id: await interactiveAccountPicker(rl, id) ?? id },
            accounts: async () => args ? viaHeadless(text) : { id: await interactiveAccountPicker(rl, id) ?? id },
            model: async () => args ? viaHeadless(text) : interactiveModelPicker(rl, id),
            effort: async () => args ? viaHeadless(text) : interactiveEffortPicker(rl, id),
            permissions: async () => args ? viaHeadless(text) : interactivePermissionPicker(rl, id),
            options: async () => interactiveHarnessOptionPicker(rl, id),
            capabilities: async () => {
              const [title = 'Capabilities', ...rest] = capabilitiesText(commandSession).split('\n');
              rl.panel?.(title, rest.join('\n'));
              if (!rl.panel) emitHarnessOutput({ panel: 'capabilities', text: [title, ...rest].join('\n') });
              await pause();
            },
            settings: async () => args ? viaHeadless(text) : { id: await interactiveSettingsPicker(config, rl, id) ?? id },
            sessions: async () => {
              if (args) return viaHeadless(text);
              const action = await interactiveSessionManager(rl, id);
              if (action === 'exit') return { exit: true };
              if (action === 'new') return { id: await newConversation(id) };
              if (action === 'resume') return { id: (await interactiveSessionPicker(rl, id))?.id ?? id };
              return {};
            },
            // Resume means reopening the selected conversation at its source:
            // retain its account, harness, and exact native session identity.
            // Moving a transcript to another provider remains an explicit
            // /provider action, never a side effect of choosing history.
            resume: async () => ({ id: (await interactiveSessionPicker(rl, id))?.id ?? id }),
            rename: async () => {
              const name = args || (await rl.question('Conversation name › ')).trim();
              if (name) await aiSessionCommand(id, `/rename ${name}`);
            },
            archive: async () => {
              const answer = (await rl.question('Archive this conversation? [y/N] › ')).trim().toLowerCase();
              if (!['y', 'yes'].includes(answer)) return {};
              await aiSessionCommand(id, '/archive');
              return { exit: true };
            },
            delete: async () => {
              const answer = (await rl.question('Delete this conversation? Type delete › ')).trim().toLowerCase();
              if (answer !== 'delete') return {};
              await aiSessionCommand(id, '/delete confirm');
              return { exit: true };
            },
            mention: async () => {
              const path = args || (await rl.question('File to attach › ')).trim();
              return path ? viaHeadless(`/mention ${path}`) : {};
            },
            review: async () => ({ prompt: reviewPrompt(args), echo: false }),
            init: async () => ({ prompt: initPrompt(commandSession), echo: false }),
            native: async () => {
              if (!args) throw new Error('usage: /native <text>  (or //text)');
              return { prompt: args, echo: true };
            },
            compact: async () => {
              const compacted = await compactConversation(id, commandSession, args, (targetId, promptText) => runInteractiveTurn(targetId, promptText, { echo: false }));
              return typeof compacted === 'string'
                ? { id: compacted, notice: 'Conversation compacted · the full transcript stays available in /resume' }
                : { notice: 'Compacted by the provider' };
            },
            export: async () => {
              const path = await exportTranscript(commandSession, args, async (existing) =>
                ['y', 'yes'].includes((await rl.question(`${compactPath(existing)} exists. Overwrite? [y/N] › `)).trim().toLowerCase()));
              return { notice: `Transcript written to ${compactPath(path)}` };
            },
            memory: async () => {
              if (route.words[0]?.toLowerCase() !== 'edit') return viaHeadless(text);
              const memory = await readMemoryFile(commandSession);
              const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
              const [editorBinary = 'vi', ...editorArgs] = editor.split(/\s+/).filter(Boolean);
              if (rl instanceof TerminalHarnessPrompter) await rl.suspend();
              try {
                await new Promise<void>((resolveEdit, rejectEdit) => {
                  const child = spawn(editorBinary, [...editorArgs, memory.path], { stdio: 'inherit', cwd: commandSession.workspace ?? process.cwd() });
                  child.once('error', rejectEdit);
                  child.once('exit', () => resolveEdit());
                });
              } finally { if (rl instanceof TerminalHarnessPrompter) rl.resume(); }
              return { notice: `Edited ${compactPath(memory.path)}` };
            },
            doctor: async () => {
              const report = await withWaiting('checking harnesses…', () => doctorSummary(commandState));
              rl.panel?.('ClikCode doctor', report);
              if (!rl.panel) emitHarnessOutput({ panel: 'doctor', text: report });
              await pause();
            },
            login: async () => {
              if (!commandHarness) throw new Error('Choose a provider before signing in.');
              if (commandSession.accountId) await manageAccountAction(rl, commandSession.accountId, 'reauthenticate');
              else await addAccountForHarness(rl, commandHarness);
              return { notice: `Signed in to ${commandHarness.displayName}` };
            },
            logout: async () => {
              if (!commandSession.accountId) throw new Error('This conversation has no account to sign out.');
              await closePersistentTransport(id);
              await withWaiting('signing out…', () => manageAccountAction(rl, commandSession.accountId!, 'disconnect'));
              return { notice: 'Signed out' };
            },
          };
          const handler = (interactive as Partial<Record<SlashHandlerKey, () => Promise<InteractiveSlashOutcome | void>>>)[route.entry.handlerKey];
          outcome = (handler ? await handler() : await viaHeadless(text)) ?? {};
        }
        if (outcome.notice) notice = outcome.notice;
        if (outcome.exit) break;
        if (outcome.id && outcome.id !== id) id = outcome.id;
        if (outcome.prompt) await runInteractiveTurn(id, outcome.prompt, { echo: outcome.echo !== false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = (error as NodeJS.ErrnoException).code === 'ERR_TURN_CANCELLED' || (error as Error).name === 'AbortError';
        // A queued turn is only consumed once its checkpoint starts. Anything
        // that throws before that -- a removed account, an unavailable model, an
        // attachment deleted since it was queued -- leaves the same message at
        // the head of the queue, so the next iteration picks it up and fails
        // identically: a hot loop that never returns a prompt and can only be
        // cleared by hand-editing harness-state.json. Release it and hand the
        // text back so the failure is visible and recoverable.
        if (queuedTurnId && !cancelled) {
          await releaseQueuedTurn(id, queuedTurnId).catch(() => undefined);
          activeTerminalHarness?.restoreDraft(line);
        }
        if (cancelled && interruptedSubmission && activeTerminalHarness) {
          const outputStarted = activeTerminalHarness.turnOutputStarted();
          const partialResponse = activeTerminalHarness.liveResponseText();
          if (outputStarted) await preserveInterruptedTurn(id, interruptedSubmission.text, partialResponse, true);
          else {
            await discardInterruptedTurn(id, interruptedSubmission.text);
            if (interruptedSubmission.restoreOnEscape) activeTerminalHarness.restoreDraft(interruptedSubmission.text);
          }
          notice = outputStarted ? 'Stopped' : interruptedSubmission.restoreOnEscape ? 'Stopped · draft restored' : 'Stopped';
        } else if (rl.render) notice = cancelled ? 'Stopped' : `Error: ${message}`;
        else emitHarnessOutput({ panel: 'error', message });
      }
    }
  } finally {
    if (usageInterval) clearInterval(usageInterval);
    if (claimInterval) clearInterval(claimInterval);
    await closePersistentTransport().catch(() => undefined);
    // Hand the conversation back so the next terminal can resume it. Best
    // effort: a failure here only means the claim expires on its own TTL.
    await releaseSessionClaim(id).catch(() => undefined);
    if (activeTerminalHarness === rl) activeTerminalHarness = undefined;
    rl.close();
  }
}

/** Refreshes this terminal's claim on its conversation. Runs on a timer rather
 * than per turn so a long turn, or a long idle stretch, both keep the claim
 * alive without any traffic of their own. */
async function refreshSessionClaim(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  claimSession(session);
  await writeState(state);
}

async function releaseSessionClaim(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session?.claim) return;
  releaseSession(session);
  await writeState(state);
}

/**
 * Runs one durable local session turn. Local sessions resolve an env reference
 * only in this process and record normalized, credential-free usage.
 */
export async function aiSessionSend(
  id: string, prompt: string, signal?: AbortSignal, run: TurnRunOptions = {},
): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('use aiGatewaySessionSend for gateway sessions');
  if (!session.accountId) throw new Error('local AI session has no account selected');
  let account = state.accounts.find((item) => item.id === session.accountId);
  if (!account) throw new Error('local AI session account was removed');
  const model = session.model ?? account.models[0] ?? null;
  if (model && account.models.length > 0 && !account.models.includes(model)) {
    throw new Error(`model "${model}" is not available through local account "${account.label}"`);
  }
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  const prepared = await prepareAttachments(session.attachments ?? []);
  let turnText = `${text}${prepared.textContext}`;
  const startedAt = Date.now();

  if (account.authKind === 'vendor-cli') {
    const harness = session.nativeHarness
      ? localHarnessForCommand(session.nativeHarness)
      : localHarnessForProvider(account.provider);
    if (!harness) throw new Error(`no native harness is registered for provider ${account.provider}`);
    if (!harnessCanRunTurns(harness)) throw new Error(`${harness.displayName} cannot execute centralized non-interactive turns`);
    if (harness.provider !== account.provider) throw new Error(`session provider ${harness.displayName} does not match account "${account.label}"`);
    const supportsImages = harnessSupportsImages(harness);
    const images = supportsImages ? prepared.images : [];
    if (prepared.images.length && !supportsImages) {
      turnText += `\n\nImage files available in the workspace:\n${prepared.images.map((path) => `- ${path}`).join('\n')}`;
    }
    session.nativeHarness = harness.command;
    session.provider = harness.provider;
    session.workspace ??= process.cwd();
    const baseMessages = sessionTranscriptMessages(session);
    const checkpoint = await DurableTurnCheckpoint.start(state, session, text, run.queuedTurnId);
    run.liveInput?.bindQueue((submission) => checkpoint.queue(submission));
    run.liveInput?.setLateSteerHandler((submission) => { void checkpoint.unqueue(submission).catch(() => undefined); });
    let switchedFrom: string | undefined;
    const attemptedAccounts = new Set<string>();
    try {
    if (session.accountFailover === 'on-quota-exhausted' && account.quotaState === 'exhausted') {
      const currentRemaining = usageLabelRemainingPercent(await accountUsageLabel(account, state));
      if (currentRemaining !== undefined && currentRemaining > 0) account.quotaState = 'available';
      else {
        attemptedAccounts.add(account.id);
        const fallback = await nextUsableFailoverAccount(
          state, account, (item) => item.authKind === 'vendor-cli', attemptedAccounts,
        );
        if (!fallback) {
          await writeState(state);
          throw new Error('all usage exhausted');
        }
        switchedFrom = account.label;
        activeTerminalHarness?.activity(`${chalk.yellow('quota exhausted')} ${chalk.dim(`${account.label} → ${fallback.label}`)}`);
        activeTerminalHarness?.phase(`switching to ${fallback.label}`);
        account = fallback;
        session.accountId = fallback.id;
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
        await checkpoint.persistNow();
      }
    }
    // A fresh native thread (no nativeSessionId yet) with prior ClikCode
    // messages already on the session means this conversation is continuing
    // under a different native identity than whatever produced those messages
    // — a cross-provider /resume, most commonly. ClikCode's own transcript
    // shows continuity either way, but the vendor process about to start has
    // no memory of any of it unless it's carried in the prompt itself; without
    // this, "continuing under Claude Code" is cosmetic in the UI only. The
    // quota-failover retry below does its own version of this for the
    // mid-conversation case; this covers every other route into a fresh
    // native thread with history already behind it.
    if ((!session.nativeSessionId || session.nativeSessionPreallocated) && baseMessages.length > 0) {
      turnText = failoverPrompt(baseMessages, turnText);
    }
    // Bounded to one attempt: this is a reactive fallback for exactly the
    // case aiHarnessSelect's own proactive check can't catch -- a harness
    // with no statusArgv (nothing to scriptably ask "am I logged in?"
    // before the turn even starts), where the *first* real signal is the
    // turn itself failing. Retrying more than once would risk a loop if
    // login genuinely doesn't fix it (wrong account, network issue, etc.).
    let authRetried = false;
    const declaredOptions = localHarnessCapabilityManifest(harness).options;
    /** Shared by every transport: usage seen on the wire for this attempt. */
    let turnUsage: NormalizedTurnUsage | undefined;
    const noteUsage = (raw: unknown): void => {
      const usage = normalizeTurnUsage(raw);
      if (!usage) return;
      turnUsage = { ...turnUsage, ...usage };
      session.lastUsage = { ...turnUsage, at: new Date().toISOString() };
      optionalTerminal()?.setTurnUsage?.(turnUsage);
    };
    const onActivity = (event: HarnessActivityEvent): void => {
      checkpoint.activity(event);
      if (activeTerminalHarness) activeTerminalHarness.activityEvent(event);
      else if (!isJsonDefaultMode()) for (const activity of renderActivityLine(event)) output.write(`${activity}\n`);
    };
    const onThought = (thought: string): void => {
      const label = thought.replace(/\s+/g, ' ').trim();
      if (label) onActivity({ kind: 'thinking', label: label.slice(0, 200) });
    };
    const onSessionId = async (nativeSessionId: string): Promise<void> => {
      if (session.nativeSessionId === nativeSessionId && !session.nativeSessionPreallocated) return;
      session.nativeSessionId = nativeSessionId;
      delete session.nativeSessionPreallocated;
      await checkpoint.persistNow();
    };
    /** Before replaying an interrupted turn somewhere else: a turn that already
     * changed the workspace is never re-run blind. */
    const confirmReplay = async (target: string): Promise<boolean> => {
      if (replayIsSafe(session.pendingTurn)) return true;
      const touched = (session.pendingTurn as { touchedFiles?: string[] } | undefined)?.touchedFiles ?? [];
      const detail = `The interrupted turn had already started changing the workspace${touched.length ? `:\n${touched.map((file) => `  ${file}`).join('\n')}` : '.'}\nReplaying asks ${target} to inspect the workspace and finish the remaining work.`;
      return (await activeTerminalHarness?.approval(`Replay the interrupted turn on ${target}?`, detail)) ?? false;
    };
    for (;;) {
      const environment = turnEnvironment(harness, account);
      const hasImages = images.length > 0;
      const transport = harnessTurnTransport(harness, hasImages, { acpImages: true });
      // A fresh native thread with prior ClikCode messages: see above. Also
      // covers an id ClikCode minted that the vendor never confirmed.
      let caughtTurnFailure: Error | undefined;
      let turnOutput: Awaited<ReturnType<typeof captureNativeHarnessTurn>> = { stdout: '', stderr: '', exitCode: 0 };
      let result: NativeTurnResult | undefined;
      let streamError: { message: string; statusCode?: number; kind?: string } | undefined;
      let cliOutputStarted = false;
      turnUsage = undefined;
      const runStructuredCliTurn = async (): Promise<NativeTurnResult> => {
        const cliHarness: AiLocalHarnessDefinition = fallbackTurnHarnesses.has(harness.command) && harness.fallbackTurn
          ? { ...harness, turn: harness.fallbackTurn } : harness;
        const turn = cliHarness.turn;
        if (!turn) throw new Error(`${harness.displayName} cannot execute centralized non-interactive turns`);
        if (promptExceedsArgvLimit(cliHarness, turnText)) {
          throw Object.assign(new Error(
            `${harness.displayName} takes its prompt as a command-line argument, and this request is ${Math.ceil(Buffer.byteLength(turnText, 'utf8') / 1024)} KB (limit ${Math.floor(maxPromptArgvBytes() / 1024)} KB). Shorten it, or save the long content to a file in the workspace and ask the agent to read it.`,
          ), { code: 'ERR_PROMPT_TOO_LARGE' });
        }
        // Only a structured-CLI harness gets an id minted here, and it stays
        // marked "preallocated" until the vendor process is seen to own it:
        // a first attempt that dies early must re-create, never `--resume` an
        // id that was never created.
        let createdHere = Boolean(session.nativeSessionId && session.nativeSessionPreallocated);
        if (!session.nativeSessionId && cliHarness.session?.idKind === 'uuid' && turn.createIdPrefix) {
          session.nativeSessionId = randomUUID();
          session.nativeSessionPreallocated = true;
          createdHere = true;
        } else if (!session.nativeSessionId && cliHarness.session?.idKind === 'history-file' && turn.createIdPrefix) {
          const nativeDirectory = join(harnessStatePath(), '..', 'native', cliHarness.command);
          await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
          session.nativeSessionId = join(nativeDirectory, `${session.id}.history.md`);
          session.nativeSessionPreallocated = true;
          createdHere = true;
        } else if (!session.nativeSessionId && cliHarness.session?.createSessionArgv) {
          session.nativeSessionId = await captureNativeHarness(cliHarness, cliHarness.session.createSessionArgv, environment);
          createdHere = true;
        }
        const argv = nativeHarnessTurnArgv(cliHarness, {
          prompt: turnText, nativeSessionId: session.nativeSessionId, createdHere,
          launchedBefore: Boolean(session.nativeStartedAt), model, workspace: session.workspace, effort: session.effort,
          permissionMode: session.permissionMode ?? 'ask', images, options: session.harnessOptions,
        });
        // Persist an allocated native identity before the provider starts so an
        // interrupted turn cannot accidentally fork the centralized conversation.
        if (createdHere) await checkpoint.persistNow();
        const confirmNativeSession = (): void => {
          if (!session.nativeSessionPreallocated) return;
          delete session.nativeSessionPreallocated;
          void checkpoint.persistNow().catch(() => undefined);
        };
        const idle = createTurnIdleController();
        turnOutput = await captureNativeHarnessTurn(cliHarness, argv, environment, {
          cwd: session.workspace,
          signal,
          idleController: idle,
          stdinText: turn.promptInput === 'stdin' ? turnText : undefined,
          onStdoutLine: (lineText) => {
            // One JSON.parse per line: everything the line means at once.
            const parsed = parseHarnessLine(cliHarness, lineText);
            if (parsed.sessionId || parsed.response || parsed.activities?.length) confirmNativeSession();
            if (parsed.response) {
              cliOutputStarted = true;
              idle.noteActivity();
              checkpoint.response(parsed.response.text, parsed.response.mode);
              activeTerminalHarness?.response(parsed.response.text, parsed.response.mode);
            }
            if (parsed.phase) activeTerminalHarness?.phase(parsed.phase);
            if (parsed.usage) noteUsage(parsed.usage);
            if (parsed.error) streamError = parsed.error;
            // The harness reports its own quota on this stream. Reading it here
            // costs nothing and refreshes on every turn, which is what keeps the
            // shared OAuth usage endpoint -- a per-account budget several open
            // chats used to exhaust between them -- down to a cold-start probe.
            // (Self-gated on a substring, so it does not re-parse ordinary lines.)
            void recordNativeStreamUsage(session, lineText).catch(() => undefined);
            for (const event of parsed.activities ?? []) {
              cliOutputStarted = true;
              noteTurnActivityEvent(idle, event);
              onActivity(event);
            }
          },
        });
        if (turnOutput.interrupted) throw Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' });
        const cliResult = nativeTurnResult(cliHarness, turnOutput.stdout);
        if (!cliResult.isError) confirmNativeSession();
        noteUsage(cliResult.usage ?? nativeTurnUsage(cliHarness, turnOutput.stdout));
        return cliResult;
      };
      try {
        if (transport === 'structured-cli' || transport === 'text-cli') {
          result = await runStructuredCliTurn();
        } else {
          // ACP and the app-server own session identity: never hand them an id
          // ClikCode minted for a CLI attempt that the vendor never confirmed.
          if (session.nativeSessionPreallocated) {
            session.nativeSessionId = undefined;
            delete session.nativeSessionPreallocated;
          }
          const persistent = run.persistentTransports
            ? persistentTransportFor(session.id, transport, JSON.stringify([harness.command, account.id, environment, session.workspace]))
            : undefined;
          try {
            if (transport === 'codex-app-server') {
              const overrides = appServerThreadOverrides(declaredOptions, session.harnessOptions);
              if (overrides.unmapped.length) activeTerminalHarness?.activity(chalk.dim(`${harness.displayName} app-server ignores: ${overrides.unmapped.join(', ')}`));
              const codexInput: CodexAppServerTurnInput = {
                binary: harness.binary, prompt: turnText, nativeSessionId: session.nativeSessionId,
                cwd: session.workspace!, model, effort: session.effort, permissionMode: session.permissionMode ?? 'ask',
                images, environment, signal, onSessionId,
                ...(overrides.configOverrides ? { configOverrides: overrides.configOverrides } : {}),
                ...(overrides.extraThreadParams ? { extraThreadParams: overrides.extraThreadParams } : {}),
                // Codex reports its own quota on this connection during the turn,
                // which is the same figure codexUsageProbe otherwise spawns a whole
                // second app-server to ask for.
                onRateLimits: (rateLimits) => {
                  // The structured reading (not just its label) so the windows'
                  // resetsAt survives into account.usage for the reset-time line.
                  void recordDerivedUsage(session, codexRateLimitsReading(rateLimits)).catch(() => undefined);
                },
                onResponseDelta: (text, mode = 'append') => {
                  checkpoint.response(text, mode);
                  activeTerminalHarness?.response(text, mode);
                },
                onPhase: (phase) => activeTerminalHarness?.phase(phase),
                onApproval: (title, detail) => activeTerminalHarness?.approval(title, detail) ?? Promise.resolve(false),
                onSteerReady: (handler) => run.liveInput?.setSteerHandler(handler ? async (steerText) => {
                  await handler(steerText);
                  await checkpoint.steer({ id: randomUUID(), text: steerText, submittedAt: new Date().toISOString() });
                } : undefined),
                onActivity, onThought, onUsage: noteUsage,
                onPlan: (entries) => optionalTerminal()?.setPlan?.(entries),
              };
              result = persistent ? await (persistent.session as CodexSession).runTurn(codexInput) : await runCodexAppServerTurn(codexInput);
            } else {
              const launch = harnessAcpLaunch(harness, { model, effort: session.effort, permissionMode: session.permissionMode ?? 'ask' });
              if (!launch) throw new Error(`${harness.displayName} does not declare an ACP launch`);
              const acpInput: AcpTurnInput = {
                binary: launch.binary, command: harness.command, prompt: turnText,
                argv: launch.modeArgv, optionPlacement: launch.optionPlacement,
                extraArgv: [...launch.optionArgv, ...declaredOptionArgv(declaredOptions, session.harnessOptions, Boolean(session.nativeSessionId))],
                ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId, sessionCreated: true } : {}),
                cwd: session.workspace!, model, effort: session.effort, permissionMode: session.permissionMode ?? 'ask',
                environment, signal, images, onSessionId,
                onResponseDelta: (delta) => {
                  checkpoint.response(delta, 'append');
                  activeTerminalHarness?.response(delta, 'append');
                },
                onActivity, onThought, onUsage: noteUsage,
                onPlan: (entries) => optionalTerminal()?.setPlan?.(entries),
                onAvailableCommands: (commands) => { nativeAvailableCommands.set(session.id, commands); },
                onApproval: (title, detail) => activeTerminalHarness?.approval(title, detail) ?? Promise.resolve(false),
              };
              try {
                result = persistent ? await (persistent.session as AcpSession).runTurn(acpInput) : await runAcpTurn(acpInput);
              } catch (error) {
                if (!(error as Error & { acpSafeToFallback?: boolean }).acpSafeToFallback || !harness.turn) throw error;
                activeTerminalHarness?.phase('using structured CLI fallback');
                result = await runStructuredCliTurn();
              }
            }
          } catch (error) {
            // After a failed turn the child's protocol state is unknown.
            if (persistent) await closePersistentTransport(session.id);
            throw error;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_TURN_CANCELLED' || (error as Error).name === 'AbortError') throw error;
        if ((error as NodeJS.ErrnoException).code === 'ERR_PROMPT_TOO_LARGE') throw error;
        caughtTurnFailure = error instanceof Error ? error : new Error(String(error));
      }
      result = caughtTurnFailure
        ? { isError: true, text: caughtTurnFailure.message }
        : result!;
      if (!session.nativeSessionId && result.nativeSessionId) session.nativeSessionId = result.nativeSessionId;
      // A non-zero exit code alone is not treated as failure here: by this
      // point nativeTurnResult has already thrown if it found neither assistant
      // text nor tool work, so a result means a real, complete turn. A harness
      // can legitimately exit non-zero because one internal sub-step failed
      // (e.g. Codex's own shell-command execution) while still producing a full
      // final answer -- the exit code by itself doesn't distinguish that from a
      // genuine failure, but an explicit isError/errorMessage signal does. An
      // empty `text` after tool work (`noAssistantText`) is success everywhere.
      if (caughtTurnFailure || result.isError) {
        const carried = (caughtTurnFailure ?? {}) as { statusCode?: number; errorKind?: string };
        const failure = caughtTurnFailure ?? Object.assign(new Error(`${harness.displayName}: ${result.text}`), { statusCode: result.statusCode });
        const failureKind = classifyAccountFailure(failure, {
          statusCode: result.statusCode ?? carried.statusCode ?? streamError?.statusCode,
          errorKind: result.errorKind ?? carried.errorKind ?? streamError?.kind,
          ...(result.rateLimitStatus ? { rateLimitStatus: result.rateLimitStatus } : {}),
          // Only the vendor's own declared error result is safe to read as
          // wording; a thrown transport error carries its own stderr/streams.
          ...(caughtTurnFailure ? {} : { isResultError: true }),
        });
        // An `experimental` structured contract an older vendor build rejects
        // outright: retry once on the proven fallback contract, and remember it.
        if (failureKind === 'other' && !cliOutputStarted && harness.experimental && harness.fallbackTurn
          && !fallbackTurnHarnesses.has(harness.command) && (transport === 'structured-cli' || transport === 'text-cli')) {
          fallbackTurnHarnesses.add(harness.command);
          activeTerminalHarness?.phase('using compatibility turn');
          continue;
        }
        if (failureKind === 'authentication-required') {
          account.status = 'needs_login';
          await checkpoint.persistNow();
          // Reactive counterpart to aiHarnessSelect's proactive login check:
          // a harness with no statusArgv gets no pre-turn "are you logged
          // in?" probe at all (harnessNeedsLogin returns false without
          // one), so its first real failure signal is the turn itself
          // erroring out -- previously surfaced as a raw, unhelpful "exited
          // N: {...}" message with no attempt to actually fix it. Same
          // suspend/login/resume mechanism aiHarnessSelect uses, triggered
          // here instead of only at provider-switch time.
          if (!authRetried && activeTerminalHarness && harness.loginArgv) {
            authRetried = true;
            await closePersistentTransport(session.id);
            if (harness.loginCapturable) {
              activeTerminalHarness.startWaiting(`signing in to ${harness.displayName}…`);
              try { await loginNativeHarness(harness, environment); } finally { activeTerminalHarness.stopWaiting(); }
            } else {
              activeTerminalHarness.activity(`${chalk.yellow('signing in to')} ${chalk.dim(harness.displayName)}`);
              await activeTerminalHarness.suspend();
              try {
                await loginNativeHarness(harness, environment);
              } finally {
                activeTerminalHarness.resume();
              }
            }
            account = await syncAccountIdentityAfterLogin(harness, account, state);
            session.accountId = account.id;
            continue;
          }
        }
        if (failureKind === 'native-thread-invalid') {
          // Confirmed live: switching this session to a different account of
          // the same provider used to leave a stale nativeSessionId in
          // place, and resuming it failed with exactly this vendor error.
          // That specific write path is now fixed separately, but recovering
          // here too means any OTHER way a thread id ends up invalid degrades
          // to "start fresh with real context replayed" instead of a hard
          // failure -- the actual answer to "how do conversations resume
          // regardless of provider or account": session.messages is the
          // durable, vendor-agnostic source of truth, and nativeSessionId is
          // a disposable optimization, never a requirement.
          if (!await confirmReplay('a fresh native session')) throw failure;
          session.nativeSessionId = undefined;
          session.nativeStartedAt = undefined;
          delete session.nativeSessionPreallocated;
          turnText = interruptedTurnFailoverPrompt(session);
          checkpoint.response('', 'replace');
          activeTerminalHarness?.response('', 'replace');
          continue;
        }
        if (failureKind !== 'quota-exhausted') throw failure;
        account.quotaState = 'exhausted';
        account.quotaRetryAt = undefined;
        attemptedAccounts.add(account.id);
        await checkpoint.persistNow();
        // Same-provider failover for the native-CLI path: switching accounts means
        // switching vendor config roots, so the in-flight native conversation can't
        // continue under the old identity — start a fresh one under the fallback.
        if (session.accountFailover !== 'on-quota-exhausted') throw failure;
        const fallback = await nextUsableFailoverAccount(
          state, account, (item) => item.authKind === 'vendor-cli', attemptedAccounts,
        );
        if (!fallback) {
          await checkpoint.persistNow();
          throw new Error('all usage exhausted');
        }
        // A turn that already edited files is not re-run blind on another
        // account: ask, and without anyone to ask, stop and say why.
        if (!await confirmReplay(fallback.label)) {
          throw new Error(`${account.label} ran out of quota after this turn had started changing the workspace, so it was not replayed automatically on ${fallback.label}. Review the workspace, then send a follow-up to continue.`);
        }
        switchedFrom = account.label;
        // Announced before the retry, not after it returns: switching accounts
        // happens inside one continuous await chain, so without this the whole
        // thing looks instantaneous and the reply just silently comes from a
        // different account with nothing to explain the (brief) extra wait.
        activeTerminalHarness?.activity(`${chalk.yellow('quota reached')} ${chalk.dim(`${switchedFrom} → ${fallback.label}, retrying…`)}`);
        activeTerminalHarness?.phase(`retrying on ${fallback.label}`);
        await closePersistentTransport(session.id);
        account = fallback;
        session.accountId = fallback.id;
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
        delete session.nativeSessionPreallocated;
        // Built while the interrupted attempt's touched-file hints are still on
        // the checkpoint; only then is the partial response cleared, because
        // the retry is a new response attempt (the direct-API path does the same).
        turnText = interruptedTurnFailoverPrompt(session);
        checkpoint.response('', 'replace');
        activeTerminalHarness?.response('', 'replace');
        continue;
      }
      session.nativeStartedAt ??= new Date().toISOString();
      delete session.nativeSessionPreallocated;
      const usage = turnUsage as NormalizedTurnUsage | undefined;
      const invocation = {
        id: randomUUID(), accountId: account.id, provider: harness.provider, model: model ?? 'provider-default',
        at: new Date().toISOString(), sessionId: session.id,
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
        ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        latencyMs: Date.now() - startedAt,
      };
      state.invocations.push(invocation);
      session.attachments = [];
      await checkpoint.complete(result.text);
      // The vendor subprocess owns persistence. Re-read its transcript after
      // exit so any source-side turns/events that were not represented by the
      // final response are reflected in ClikCode before the turn is saved.
      await synchronizeNativeTranscript(state, session);
      await writeState(state);
      if (!activeTerminalHarness) emitHarnessOutput({ session, text: result.text, usage: { attributedBy: harness.command, ...usage }, invocation, ...(switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: 'quota-exhausted' } : {}) });
      return;
    }
    } finally {
      await checkpoint.flush();
    }
  }

  if (prepared.images.length) throw new Error('Image attachments need a vendor harness that accepts images; direct API-key accounts do not. Switch providers with /provider or clear them with /attachments clear.');
  if (!model) throw new Error('local AI session has no model selected');
  const baseMessages = sessionTranscriptMessages(session);
  const checkpoint = await DurableTurnCheckpoint.start(state, session, text, run.queuedTurnId);
  run.liveInput?.bindQueue((submission) => checkpoint.queue(submission));
    run.liveInput?.setLateSteerHandler((submission) => { void checkpoint.unqueue(submission).catch(() => undefined); });
  let switchedFrom: string | undefined;
  const attemptedAccounts = new Set<string>();
  try {
  if (session.accountFailover === 'on-quota-exhausted' && account.quotaState === 'exhausted') {
    attemptedAccounts.add(account.id);
    const fallback = await nextUsableFailoverAccount(
      state, account, (item) => item.authKind === 'api-key' && item.models.includes(model), attemptedAccounts,
    );
    if (!fallback) {
      await writeState(state);
      throw new Error('all usage exhausted');
    }
    switchedFrom = account.id;
    activeTerminalHarness?.activity(`${chalk.yellow('quota exhausted')} ${chalk.dim(`${account.label} → ${fallback.label}`)}`);
    activeTerminalHarness?.phase(`switching to ${fallback.label}`);
    account = fallback;
    session.accountId = fallback.id;
    await checkpoint.persistNow();
  }
  const invoke = (active: AiHarnessAccount) => {
    // A retry is a new response attempt. Clear any partial text from the
    // exhausted account, then append each real provider delta directly to the
    // checkpoint/UI. The router has always exposed onDelta;
    // omitting it here was why direct-API responses appeared only at the end.
    checkpoint.response('', 'replace');
    activeTerminalHarness?.response('', 'replace');
    return streamLocalAiTurn({
      provider: session.provider ?? active.provider, model, apiKey: localApiKey(active), credentialSource: 'env',
      messages: [...baseMessages, { role: 'user', content: turnText }], reasoningEffort: session.effort as never,
      ...(signal ? { abortSignal: signal } : {}),
      onDelta: (delta: string) => {
        checkpoint.response(delta, 'append');
        activeTerminalHarness?.response(delta, 'append');
      },
    });
  };
  let turn: Awaited<ReturnType<typeof streamLocalAiTurn>>;
  for (;;) {
    try {
      turn = await invoke(account);
      break;
    } catch (error) {
      const failureKind = classifyAccountFailure(error);
      if (failureKind === 'authentication-required') {
        account.status = 'needs_login';
        await writeState(state);
      }
      if (session.accountFailover !== 'on-quota-exhausted' || failureKind !== 'quota-exhausted') throw error;
      const exhaustedAccount = account;
      exhaustedAccount.quotaState = 'exhausted';
      exhaustedAccount.quotaRetryAt = undefined;
      attemptedAccounts.add(exhaustedAccount.id);
      // Preserve every failed candidate before looking for the next one. A
      // chain of stale account records therefore terminates instead of merely
      // moving the same failure to one alternate and abandoning the router.
      await writeState(state);
      const fallback = await nextUsableFailoverAccount(
        state, exhaustedAccount,
        (item) => item.authKind === 'api-key' && item.models.includes(model),
        attemptedAccounts,
      );
      if (!fallback) {
        await writeState(state);
        throw new Error('all usage exhausted');
      }
      switchedFrom ??= exhaustedAccount.id;
      activeTerminalHarness?.activity(`${chalk.yellow('quota reached')} ${chalk.dim(`${exhaustedAccount.label} → ${fallback.label}, retrying…`)}`);
      activeTerminalHarness?.phase(`retrying on ${fallback.label}`);
      account = fallback;
      session.accountId = fallback.id;
    }
  }
  const invocation = {
    id: randomUUID(), sessionId: session.id, accountId: account.id, provider: session.provider ?? account.provider, model,
    at: new Date().toISOString(), inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens, latencyMs: Date.now() - startedAt,
  };
  if (activeTerminalHarness && Array.isArray(turn.toolCalls)) {
    for (const call of turn.toolCalls) {
      const name = call && typeof call.name === 'string' ? call.name : 'tool';
      // The tool's own name, with nothing in front of it -- the same rule the
      // native-harness rows follow. This is the Gateway/direct-API path, and
      // it was the one place still prepending a status word.
      activeTerminalHarness.activity(chalk.dim(name));
    }
  }
  state.invocations.push(invocation);
  session.attachments = [];
  await checkpoint.complete(turn.text);
  if (!activeTerminalHarness) emitHarnessOutput({ session, text: turn.text, toolCalls: turn.toolCalls, usage: turn.usage, invocation, ...(switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: 'quota-exhausted' } : {}) });
  } finally {
    await checkpoint.flush();
  }
}

/** What the Gateway's final `result` event says that the text did not. */
export function gatewayResultNotice(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const result = data as { requiresConfirmation?: unknown; pendingToolCalls?: unknown };
  const pending = Array.isArray(result.pendingToolCalls) ? result.pendingToolCalls : [];
  if (result.requiresConfirmation !== true && pending.length === 0) return undefined;
  const names = pending.map((call) => {
    const record = call && typeof call === 'object' ? call as { name?: unknown; tool?: unknown; toolName?: unknown } : {};
    return [record.name, record.tool, record.toolName].find((value): value is string => typeof value === 'string');
  }).filter((name): name is string => Boolean(name));
  const what = pending.length ? `${pending.length} action${pending.length === 1 ? '' : 's'}${names.length ? ` (${[...new Set(names)].slice(0, 5).join(', ')})` : ''}` : 'an action';
  return `The platform is holding ${what} for your confirmation and has NOT run ${pending.length === 1 || !pending.length ? 'it' : 'them'}. ClikCode cannot confirm Gateway actions yet — approve ${pending.length === 1 || !pending.length ? 'it' : 'them'} in the ClikDeploy dashboard assistant.`;
}

/** Send a gateway session through the existing authenticated platform assistant stream. */
export async function aiGatewaySessionSend(
  config: Conf, id: string, prompt: string, signal?: AbortSignal, run: TurnRunOptions = {},
): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route !== 'gateway') return aiSessionSend(id, prompt, signal, run);
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  const prepared = await prepareAttachments(session.attachments ?? []);
  if (prepared.images.length) throw new Error('ClikDeploy Gateway does not accept image attachments. Switch to a local provider with /provider or clear them with /attachments clear.');
  const turnText = `${text}${prepared.textContext}`;
  const baseUrl = getApiUrl(config).replace(/\/$/, '');
  const apiKey = getApiKeyForUrl(config, baseUrl);
  if (!apiKey) throw new Error(`ClikDeploy Gateway is not connected; run \`${harnessCommand()} gateway login\` first`);
  const startedAt = Date.now();
  const baseMessages = sessionTranscriptMessages(session);
  const checkpoint = await DurableTurnCheckpoint.start(state, session, text, run.queuedTurnId);
  // The coding agent runs here, on this machine; the gateway supplies the
  // model step and nothing else. Only a gateway that cannot serve that -- an
  // administrator kill switch, or a deployment older than the endpoint --
  // falls back to the platform assistant below, and says so when it does.
  try {
    const harnessTurn = await runGatewayHarnessSessionTurn({
      session, prompt: turnText, baseUrl, apiKey, version: CLIKCODE_VERSION,
      ...(activeTerminalHarness ? { prompter: activeTerminalHarness } : {}),
      ...(signal ? { signal } : {}),
      ...(prepared.images.length ? { images: prepared.images } : {}),
      onActivity: (event) => checkpoint.activity(event),
    });
    if (harnessTurn.isError) throw new Error(harnessTurn.text || 'gateway harness turn failed');
    const harnessInvocation = {
      id: randomUUID(), sessionId: session.id, accountId: 'gateway',
      provider: session.provider ?? 'clikdeploy-gateway', model: session.model ?? 'platform',
      at: new Date().toISOString(), latencyMs: Date.now() - startedAt,
    };
    state.invocations.push(harnessInvocation);
    session.attachments = [];
    await checkpoint.complete(harnessTurn.text);
    if (!activeTerminalHarness) {
      emitHarnessOutput({
        session, text: harnessTurn.text, usage: { attributedBy: 'clikdeploy-gateway' }, invocation: harnessInvocation,
      });
    }
    await checkpoint.flush();
    return;
  } catch (error) {
    if (!gatewayHarnessUnavailable(error)) { await checkpoint.flush(); throw error; }
    const notice = gatewayHarnessFallbackNotice(error);
    if (activeTerminalHarness) activeTerminalHarness.activity(chalk.dim(notice));
    else if (!isJsonDefaultMode()) output.write(`${chalk.yellow('Gateway:')} ${notice}\n`);
  }
  run.liveInput?.bindQueue((submission) => checkpoint.queue(submission));
    run.liveInput?.setLateSteerHandler((submission) => { void checkpoint.unqueue(submission).catch(() => undefined); });
  try {
  const response = await fetch(`${baseUrl}/api/assistant/chat`, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${apiKey}`, accept: 'text/event-stream', 'content-type': 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
    body: JSON.stringify({ message: turnText, messages: baseMessages, mode: 'plan' }),
  });
  if (!response.ok || !response.body) throw new Error(`gateway AI request failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  let gatewayNotice: string | undefined;
  const streamToTerminal = !isJsonDefaultMode() && !activeTerminalHarness;
  let wroteDelta = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith('data:')) {
        const event = JSON.parse(frame.slice('data:'.length).trim()) as { type?: string; text?: string; error?: string; label?: string; kind?: 'thinking' | 'tool-start'; tool?: string; data?: unknown };
        // The server's final `result` carries what the text stream cannot:
        // tool calls it is holding back for confirmation. Dropping it left
        // the user with a reply that implied work the platform never did.
        if (event.type === 'result') gatewayNotice = gatewayResultNotice(event.data) ?? gatewayNotice;
        if (event.type === 'delta' && typeof event.text === 'string') {
          checkpoint.response(event.text, 'append');
          activeTerminalHarness?.phase('generating response');
          activeTerminalHarness?.response(event.text, 'append');
          reply += event.text;
          if (streamToTerminal) { output.write(event.text); wroteDelta = true; }
        }
        // `kind`/`tool` are real, additive fields on the wire protocol
        // (apps/web's chat-stream.ts / assistant/chat route) mapping the
        // backend's own `{ status: 'thinking' }` / `{ status: 'tool_call',
        // tool }` into the same canonical shape native harnesses' own
        // parsers produce, so a Gateway tool call's *activity log line*
        // renders identically to a Codex or Claude Code one — same glyph,
        // same color, same bare-subject wording (renderActivityLine adds its
        // own verb, so the canonical label here is the bare tool name via
        // `tool`, not the backend's already-verbed `label`). The phase
        // (spinner text) uses `label` directly instead, since the backend's
        // phrasing ("Restarting the app…") is already the ideal spinner
        // text and the terminal lifecycle's own "running X" wording is for
        // bare native-harness tool names, not a pre-verbed phrase. There's
        // no 'tool-done' here because AssistantChatEvent has no completion
        // signal to report (verified: 'tool_call' fires once, nothing after
        // it) — a real gap in what the agent loop reports, not something to
        // fake here.
        if (event.type === 'status' && typeof event.label === 'string') {
          const activityEvent: HarnessActivityEvent = { kind: event.kind === 'tool-start' ? 'tool-start' : 'thinking', label: event.tool ?? event.label };
          checkpoint.activity(activityEvent);
          if (activeTerminalHarness) {
            activeTerminalHarness.activityEvent(activityEvent);
            // Gateway labels are already humanized (for example,
            // "Restarting the app…"). Apply that richer label after the
            // generic lifecycle updates active-tool tracking.
            activeTerminalHarness.phase(event.label);
          }
          else if (!isJsonDefaultMode()) for (const activity of renderActivityLine(activityEvent)) output.write(`${activity}\n`);
        }
        if (event.type === 'error') throw new Error(event.error ?? 'gateway AI request failed');
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (gatewayNotice) {
    if (activeTerminalHarness) activeTerminalHarness.activity(`${chalk.yellow('gateway')} ${chalk.dim(gatewayNotice)}`);
    else if (!isJsonDefaultMode()) output.write(`${wroteDelta ? '\n' : ''}${chalk.yellow('Gateway:')} ${gatewayNotice}\n`);
    if (!reply) reply = gatewayNotice;
  }
  if (!reply) throw new Error('gateway AI response contained no text');
  const invocation = { id: randomUUID(), sessionId: session.id, accountId: 'gateway', provider: session.provider ?? 'clikdeploy-gateway', model: session.model ?? 'platform', at: new Date().toISOString(), latencyMs: Date.now() - startedAt };
  state.invocations.push(invocation);
  session.attachments = [];
  await checkpoint.complete(reply);
  if (wroteDelta) output.write('\n\n');
  else if (!activeTerminalHarness) emitHarnessOutput({ session, text: reply, usage: { attributedBy: 'clikdeploy-gateway' }, invocation, ...(gatewayNotice ? { notice: gatewayNotice } : {}) });
  } finally {
    await checkpoint.flush();
  }
}

export async function aiSessionSet(id: string, options: { route?: AiHarnessRoute; account?: string; provider?: string; model?: string; effort?: string; permissions?: AiHarnessPermissionMode; accountFailover?: 'never' | 'on-quota-exhausted'; nativeSession?: string }): Promise<void> {
  if (options.route !== undefined && options.route !== 'local' && options.route !== 'gateway') throw new Error('route must be local or gateway');
  if (options.accountFailover !== undefined && options.accountFailover !== 'never' && options.accountFailover !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
  if (options.permissions !== undefined && !VALID_PERMISSION_MODES.includes(options.permissions)) throw new Error('permissions must be ask, bypass, or auto');
  const state = await readState();
  const index = state.sessions.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`AI session "${id}" was not found`);
  const current = state.sessions[index];
  const effectiveRoute = options.route ?? current.route;
  if (effectiveRoute === 'gateway' && (options.account || options.provider || options.model || options.effort || options.accountFailover || options.nativeSession)) {
    throw new Error('Gateway account, provider, model, effort, failover, and native sessions are selected by ClikDeploy platform routing and cannot be overridden per session.');
  }
  const account = options.account === undefined
    ? undefined
    : state.accounts.find((item) => item.id === options.account || item.label === options.account);
  if (options.account !== undefined && !account) throw new Error(`local AI account "${options.account}" was not found`);
  if (account && options.provider && options.provider !== account.provider) {
    throw new Error(`account "${account.label}" belongs to ${account.provider}, not ${options.provider}`);
  }
  if (!account && options.provider && current.accountId) {
    const currentAccount = state.accounts.find((item) => item.id === current.accountId);
    if (currentAccount && currentAccount.provider !== options.provider) {
      throw new Error(`account "${currentAccount.label}" belongs to ${currentAccount.provider}; select a matching account when changing provider`);
    }
  }
  if (options.nativeSession !== undefined) {
    if (!current.nativeHarness) throw new Error('launch a native harness for this ClikCode session before attaching its native session id');
    const harness = localHarnessForCommand(current.nativeHarness);
    if (!harness?.session?.resumeIdPrefix) throw new Error(`${harness?.displayName ?? current.nativeHarness} does not declare exact native-session resume support`);
    if (!options.nativeSession.trim()) throw new Error('native session id cannot be empty');
  }
  const selectedHarness = account
    ? localHarnessForProvider(account.provider)
    : options.provider
      ? localHarnessForProvider(options.provider)
      : current.nativeHarness ? localHarnessForCommand(current.nativeHarness) : undefined;
  if (effectiveRoute === 'local' && (options.account || options.provider) && !selectedHarness) {
    throw new Error(`unknown local provider "${options.provider ?? account?.provider}"`);
  }
  if (options.model && selectedHarness && !selectedHarness.modelArgvPrefix) {
    throw new Error(`${selectedHarness.displayName} does not publish a model selector.`);
  }
  if (options.effort && selectedHarness) {
    const effortOption = optionForHarness(selectedHarness, 'effort');
    if (!effortOption) throw new Error(`${selectedHarness.displayName} does not publish a configurable reasoning-effort flag.`);
    parseHarnessOption(effortOption, options.effort);
  }
  if (options.permissions && (!selectedHarness || !harnessSupportsPermissionMode(selectedHarness, options.permissions))) {
    if (!selectedHarness) throw new Error('Choose a provider before setting permissions.');
    throw new Error(`${selectedHarness.displayName} does not support ${options.permissions} permissions.`);
  }
  const base: HarnessSession = { ...current };
  if (options.route === 'local' && current.route === 'gateway') applyFreshLocalSessionPolicy(state, base);
  const next: HarnessSession = {
    ...base,
    ...(options.route ? { route: options.route } : {}),
    ...(account ? { accountId: account.id, provider: options.provider ?? account.provider } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.permissions ? { permissionMode: options.permissions } : {}),
    ...(options.accountFailover ? { accountFailover: options.accountFailover } : {}),
    ...(options.nativeSession !== undefined ? { nativeSessionId: options.nativeSession.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (effectiveRoute === 'gateway') applyGatewaySessionPolicy(next);
  else if (account) {
    if (account.authKind === 'vendor-cli' && selectedHarness && harnessCanRunTurns(selectedHarness)) {
      if (next.nativeHarness !== selectedHarness.command || current.accountId !== account.id) {
        next.nativeSessionId = undefined;
        next.nativeStartedAt = undefined;
      }
      next.nativeHarness = selectedHarness.command;
    } else {
      delete next.nativeHarness;
      delete next.nativeSessionId;
      delete next.nativeStartedAt;
    }
  }
  state.sessions[index] = next;
  await writeState(state);
  emitJson({ session: next });
}

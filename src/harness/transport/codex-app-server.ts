import { activityOutput } from '../protocol/activity-events.js';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnPortable } from './spawn.js';
import { isTurnCancelled, turnCancelledError } from '../../agent/cancellation.js';
import { JSONRPC_SETUP_TIMEOUT_MS, JsonRpcPeer } from './jsonrpc-peer.js';
import type { AiHarnessPermissionMode } from '../definition.js';
import type { HarnessActivityEvent } from '../prompter.js';
import type { HarnessPlanEntry, HarnessTurnObserver } from '../events/turn-observer.js';
import { commandOutcome, fileChangeActivity, thoughtLabel } from '../protocol/activity-events.js';
import { categoryOf, formatToolRow, toolLabel } from '../protocol/tools.js';
import { asRecord } from '../protocol/json-lines.js';
import { countsOf, turnShareOf, turnStopReason, type TurnUsage } from '../protocol/turn-usage.js';
import { BackgroundTurnChannel, type BackgroundTurnEnd, type VendorBackgroundTurnHandler } from './background-turn.js';
import { createTurnWatchdog, turnIdleError, type TurnWatchdog } from './turn-watchdog.js';

type JsonObject = Record<string, unknown>;

export interface CodexAppServerTurnInput extends HarnessTurnObserver {
  binary: string;
  prompt: string;
  nativeSessionId?: string;
  cwd: string;
  model?: string | null;
  effort?: string;
  permissionMode: AiHarnessPermissionMode;
  images?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** Per-harness Codex config overrides (`config` of thread/start|resume),
   * e.g. `{ 'tools.web_search': true, profile: 'work' }`. */
  configOverrides?: Record<string, unknown>;
  /** Extra top-level thread/start|resume params; wins over the defaults. */
  extraThreadParams?: Record<string, unknown>;
  /** Timeout for initialize / thread / turn-start requests. Default 20s. */
  setupTimeoutMs?: number;
}

type CodexErrorKind = 'quota' | 'auth' | 'other';
type CodexSpawn = (binary: string, argv: readonly string[], options: SpawnOptions) => ChildProcess;

export interface CodexSession {
  runTurn(input: CodexAppServerTurnInput): Promise<CodexAppServerTurnResult>;
  /** Steer the active turn. Rejects when no turn is running. */
  steer(text: string): Promise<void>;
  /** Interrupt the active turn; the child survives if it acknowledges in 2s. */
  cancel(): void;
  close(): Promise<void>;
}

interface CodexSessionOptions {
  spawn?: CodexSpawn;
  /** Receives work the vendor does between ClikCode turns. */
  backgroundTurns?: VendorBackgroundTurnHandler;
  /** Watchdog budgets (see turn-watchdog.ts); tests shorten them. */
  idleMs?: number;
  toolIdleMs?: number;
}

interface CodexAppServerTurnResult {
  text: string;
  nativeSessionId: string;
  isError?: boolean;
  statusCode?: number;
}

export function completedAgentMessageUpdate(
  streamed: string, completed: string,
): { text: string; mode: 'append' } | undefined {
  if (!streamed) return completed ? { text: completed, mode: 'append' } : undefined;
  return completed.startsWith(streamed) && completed.length > streamed.length
    ? { text: completed.slice(streamed.length), mode: 'append' }
    : undefined;
}

export function codexSteerParams(threadId: string, turnId: string, text: string): JsonObject {
  return {
    threadId, expectedTurnId: turnId,
    input: [{ type: 'text', text, text_elements: [] }],
  };
}


function codexCommandText(command: unknown): string | undefined {
  if (typeof command === 'string' && command) return command;
  if (Array.isArray(command) && command.length) return command.map(String).join(' ');
  return undefined;
}

export function codexActivityForItem(item: JsonObject, completed: boolean): HarnessActivityEvent | undefined {
  const type = String(item.type ?? '');
  const id = typeof item.id === 'string' ? item.id : undefined;
  const completedKind = item.status === 'failed' || item.status === 'error'
    || (typeof item.exitCode === 'number' && item.exitCode !== 0)
    || (typeof item.exit_code === 'number' && item.exit_code !== 0)
    ? 'tool-error' as const : 'tool-done' as const;
  // A call the user (or an approval policy) declined never ran; it is not a
  // success, which is how it read.
  if (completed && item.status === 'declined') {
    const declined = codexActivityForItem({ ...item, status: 'completed' }, false);
    if (declined && declined.kind !== 'thinking') return { ...declined, kind: 'tool-error', output: ['declined'] };
  }
  if (type === 'commandExecution') {
    const aggregated = completed && typeof item.aggregatedOutput === 'string' ? activityOutput(item.aggregatedOutput, { tail: true }) : {};
    return {
      kind: completed ? completedKind : 'tool-start', label: formatToolRow('shell', codexCommandText(item.command) ?? 'command', 'run'), category: 'run', ...(id ? { id } : {}),
      ...aggregated,
      ...(completed ? commandOutcome(item) : {}),
    };
  }
  if (type === 'fileChange') return { kind: completed ? completedKind : 'tool-start', ...fileChangeActivity(item.changes), ...(id ? { id } : {}) };
  if (type === 'collabAgentToolCall') {
    const tool = String(item.tool ?? item.name ?? 'agent');
    const detail = typeof item.prompt === 'string' ? item.prompt
      : typeof item.task === 'string' ? item.task
        : typeof item.description === 'string' ? item.description : undefined;
    return {
      kind: completed ? completedKind : 'tool-start', label: formatToolRow('agent', detail ?? tool), agent: true, ...(id ? { id } : {}),
    };
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const name = typeof item.server === 'string' && typeof item.tool === 'string' ? `mcp__${item.server}__${item.tool}` : String(item.tool ?? item.server ?? item.name ?? 'tool');
    const args = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments) ? item.arguments as Record<string, unknown> : undefined;
    const classified = categoryOf(name, args, 'codex');
    // What it returned, or why it failed: an MCP result's text content, a
    // dynamic tool's content items, the error's message.
    const error = asRecord(item.error);
    const failed = completed && (item.success === false || (error && typeof error.message === 'string'));
    const resultText = [
      ...(Array.isArray(asRecord(item.result)?.content) ? asRecord(item.result)!.content as unknown[] : []),
      ...(Array.isArray(item.contentItems) ? item.contentItems as unknown[] : []),
    ].flatMap((part) => { const text = asRecord(part)?.text; return typeof text === 'string' ? [text] : []; }).join('\n');
    const said = failed && typeof error?.message === 'string' ? error.message : resultText;
    return {
      kind: failed ? 'tool-error' : completed ? completedKind : 'tool-start', label: toolLabel(name, args, classified.category), ...classified, ...(id ? { id } : {}),
      ...(completed && said ? activityOutput(said) : {}),
      ...(completed ? commandOutcome(item) : {}),
    };
  }
  if (type === 'webSearch') {
    // What it did: a search, or a page it opened or searched in.
    const action = asRecord(item.action);
    const url = typeof action?.url === 'string' ? action.url : undefined;
    const label = action?.type === 'openPage' && url ? formatToolRow('web_fetch', url, 'fetch')
      : action?.type === 'findInPage' && url ? formatToolRow('web_fetch', `${typeof action.pattern === 'string' ? `"${action.pattern}" in ` : ''}${url}`, 'fetch')
        : formatToolRow('web_search', [item.query, action?.query].find((query): query is string => typeof query === 'string' && query.trim().length > 0), 'fetch');
    return { kind: completed ? completedKind : 'tool-start', label, category: 'fetch', ...(id ? { id } : {}) };
  }
  if (type === 'reasoning' && completed) {
    // The item's id, so the finished summary replaces the thought that
    // streamed for it rather than adding a second one.
    const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === 'string').join('\n\n') : '';
    if (summary) return { kind: 'thinking', label: thoughtLabel(summary), ...(id ? { id } : {}) };
  }
  return undefined;
}

/** One turn's usage from Codex's thread-level reading
 * (`thread/tokenUsage/updated`: `{total, last, modelContextWindow}`).
 *
 * `total` is the whole THREAD's, so a resumed conversation's first turn
 * reported everything the thread had ever used as that turn's usage; `last`
 * is the latest model CALL's, one of the several a turn with tools makes. The
 * turn is what the total grew by since the turn began: the total at the
 * turn's first reading less that reading's own call. That also holds when a
 * reading is sent twice, as Codex does alongside rate-limit updates. `start`
 * is the baseline the first reading set, handed back for the next one. */
export function codexTurnUsage(reading: JsonObject, start?: TurnUsage): { usage: TurnUsage; start: TurnUsage } | undefined {
  const total = asRecord(reading.total) ?? asRecord(reading.total_token_usage);
  if (!total) return undefined;
  const last = asRecord(reading.last) ?? asRecord(reading.last_token_usage);
  const totalCounts = countsOf(total);
  const lastCounts = countsOf(last);
  const baseline = start ?? turnShareOf(totalCounts, lastCounts);
  const usage = turnShareOf(totalCounts, baseline);
  const window = reading.modelContextWindow ?? reading.model_context_window;
  if (typeof window === 'number' && window > 0) usage.contextWindow = window;
  // The latest call read the whole conversation and wrote on top of it.
  if (lastCounts.totalTokens) usage.contextUsed = lastCounts.totalTokens;
  return { usage, start: baseline };
}

export function codexPermissionSettings(mode: AiHarnessPermissionMode): {
  approvalPolicy: 'never' | 'on-request'; sandbox: 'danger-full-access' | 'workspace-write'; approvalsReviewer: 'user' | 'auto_review';
} {
  return mode === 'bypass'
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' }
    : { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user' };
}


/** Classify a Codex failure from its structured error (`codexErrorInfo`,
 * JSON-RPC data) and message. Tolerant by design: the info member is a string
 * in some versions and a tagged object carrying an HTTP status in others. */
function codexErrorKind(error: unknown): { errorKind: CodexErrorKind; statusCode?: number } {
  const source = error && typeof error === 'object' ? error as JsonObject : { message: String(error ?? '') };
  const info = source.codexErrorInfo ?? source.codex_error_info ?? source.data ?? '';
  const text = `${typeof info === 'string' ? info : JSON.stringify(info ?? '')} ${String(source.message ?? '')}`;
  const status = /"?http_?status_?code"?\s*[:=]\s*(\d{3})/i.exec(text)?.[1];
  const statusCode = status ? Number(status) : undefined;
  if (statusCode === 429 || /usage.?limit|rate.?limit|quota|too many requests|\b429\b/i.test(text)) return { errorKind: 'quota', statusCode: statusCode ?? 429 };
  if (statusCode === 401 || statusCode === 403 || /unauthori[sz]ed|authenticat|not logged in|log ?in required|api.?key|\b401\b|\b403\b/i.test(text)) return { errorKind: 'auth', statusCode: statusCode ?? 401 };
  return { errorKind: 'other', ...(statusCode ? { statusCode } : {}) };
}

/** What the user is approving: the command and where it runs, or the files. */
function codexApprovalDetail(params: JsonObject, item?: JsonObject): string {
  const lines: string[] = [];
  const command = codexCommandText(params.command) ?? codexCommandText(item?.command);
  if (command) lines.push(`$ ${command}`);
  const cwd = params.cwd ?? item?.cwd;
  if (typeof cwd === 'string' && cwd) lines.push(`cwd: ${cwd}`);
  const changes = params.changes ?? params.fileChanges ?? item?.changes;
  const paths = Array.isArray(changes)
    ? changes.flatMap((change) => typeof (change as JsonObject)?.path === 'string' ? [String((change as JsonObject).path)] : [])
    : changes && typeof changes === 'object' ? Object.keys(changes) : [];
  lines.push(...paths.slice(0, 8), ...(paths.length > 8 ? [`... ${paths.length - 8} more files`] : []));
  if (typeof params.grantRoot === 'string' && params.grantRoot) lines.push(`grants write access to ${params.grantRoot}`);
  if (typeof params.reason === 'string' && params.reason) lines.push(params.reason);
  return lines.join('\n') || 'Codex requested additional permission';
}

function codexPlanEntries(params: JsonObject): HarnessPlanEntry[] {
  return Array.isArray(params.plan)
    ? params.plan.flatMap((entry) => {
      const step = (entry as JsonObject)?.step ?? (entry as JsonObject)?.content;
      return typeof step === 'string' ? [{ content: step, status: String((entry as JsonObject).status ?? 'pending') }] : [];
    })
    : [];
}

const INTERRUPT_SETTLE_MS = 2000;
const OUTPUT_EMIT_INTERVAL_MS = 150;
const OUTPUT_BUFFER_LIMIT = 4000;

/** Notifications that carry the vendor's work (and so can open a background
 * turn). Status, usage and server bookkeeping never do. */
const CONTENT_NOTIFICATION = /^(?:item\/|turn\/(?:started|completed|plan\/updated)$)/;

/** A sub-agent's name as Codex paths it (`/root/run_tests` -> `run_tests`). */
function subAgentLabel(path: unknown): string {
  const name = typeof path === 'string' ? path.split('/').filter(Boolean).pop() : undefined;
  return name && name !== 'root' ? `subagent ${name}` : 'subagent';
}

interface LiveServer {
  peer: JsonRpcPeer;
  key: string;
  initialized: boolean;
  threadId?: string;
}

/** Whatever is receiving the vendor's notifications right now: the user's
 * turn, or a background turn when there is none. */
interface Stream {
  observer: HarnessTurnObserver;
  lastAgentMessage: string;
  streamedMessage: string;
  sawActivity: boolean;
  lastError?: JsonObject;
  items: Map<string, JsonObject>;
  output: Map<string, { text: string; emittedAt: number }>;
  /** Reasoning streamed so far, per reasoning item (and per raw/summary). */
  thoughts: Map<string, string>;
  /** The thread's usage when this turn began (codexTurnUsage). */
  usageStart?: TurnUsage;
  /** Compaction is announced twice (an item, and a deprecated notification). */
  compacted?: boolean;
  watchdog?: TurnWatchdog;
}

interface ActiveTurn extends Stream {
  input: CodexAppServerTurnInput;
  done: boolean;
  threadId?: string;
  turnId?: string;
  complete: (error?: Error) => void;
  fail: (error: Error) => void;
}

interface BackgroundRun extends Stream {
  channel: BackgroundTurnChannel;
  /** A turn the vendor started on our thread, until its turn/completed. */
  vendorTurnId?: string;
}

/** Work still running on the vendor's side: a tool item of our thread that
 * has not completed, or a sub-agent thread that is active. */
interface PendingWork { label: string; turnId?: string }

class CodexSessionImpl implements CodexSession {
  private live?: LiveServer;
  private turn?: ActiveTurn;
  private background?: BackgroundRun;
  private readonly pendingWork = new Map<string, PendingWork>();
  private settling?: Promise<void>;
  private turnCompletedWaiter?: () => void;
  private threadId?: string;
  private lastPermissionMode: AiHarnessPermissionMode = 'ask';
  private isClosed = false;
  private readonly spawn: CodexSpawn;
  private readonly onBackgroundTurn?: VendorBackgroundTurnHandler;
  private readonly idleMs?: number;
  private readonly toolIdleMs?: number;

  constructor(options: CodexSessionOptions) {
    this.spawn = options.spawn ?? ((binary, argv, spawnOptions) => spawnPortable(binary, [...argv], spawnOptions));
    this.onBackgroundTurn = options.backgroundTurns;
    this.idleMs = options.idleMs;
    this.toolIdleMs = options.toolIdleMs;
  }

  async runTurn(input: CodexAppServerTurnInput): Promise<CodexAppServerTurnResult> {
    if (this.isClosed) throw new Error('Codex session is closed');
    if (this.turn) throw new Error('Codex session already has an active turn');
    // From here on the user's turn receives what the vendor says.
    this.finishBackground('superseded');
    this.lastPermissionMode = input.permissionMode;
    let fail!: (error: Error) => void;
    let complete!: (error?: Error) => void;
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    failure.catch(() => undefined);
    const completion = new Promise<void>((resolve, reject) => { complete = (error) => error ? reject(error) : resolve(); });
    completion.catch(() => undefined);
    const turn: ActiveTurn = {
      input, observer: input, done: false, lastAgentMessage: '', streamedMessage: '', sawActivity: false,
      items: new Map(), output: new Map(), thoughts: new Map(), complete, fail,
    };
    this.turn = turn;
    const onAbort = (): void => this.cancelTurn(turn);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let succeeded = false;
    try {
      if (this.settling) await this.settling;
      if (input.signal?.aborted) throw turnCancelledError();
      const flow = this.flow(turn, completion);
      flow.catch(() => undefined);
      const result = await Promise.race([flow, failure]);
      succeeded = true;
      return result;
    } catch (error) {
      const failureError = error instanceof Error ? error : new Error(String(error));
      if (!isTurnCancelled(failureError)) {
        // Prefer the server's structured error over the transport's message.
        Object.assign(failureError, codexErrorKind(turn.lastError ?? failureError));
        // A failed *turn* leaves a healthy server; anything else is unknown.
        if (!(failureError as { codexTurnFailed?: boolean }).codexTurnFailed) this.dropLive(failureError);
      }
      throw failureError;
    } finally {
      turn.done = true;
      turn.watchdog?.stop();
      input.onSteerReady?.(undefined);
      input.signal?.removeEventListener('abort', onAbort);
      if (this.turn === turn) this.turn = undefined;
      // A turn/steer in flight when the turn ends is never answered.
      this.live?.peer.rejectPending(new Error('Codex turn ended'), (method) => method !== 'turn/interrupt');
      // A reply can be written while a shell or a sub-agent it started is
      // still running. That work is reported as a background turn; after a
      // failed or stopped turn nothing is known to be running any more.
      if (!succeeded) { this.pendingWork.clear(); this.settleBackground(); } else if (this.pendingWork.size && this.live) this.openBackground('background-work', undefined, turn.items);
    }
  }

  async steer(text: string): Promise<void> {
    const turn = this.turn;
    const live = this.live;
    if (!turn || turn.done || !live || !turn.threadId || !turn.turnId) throw new Error('Codex has no active turn to steer');
    await live.peer.request('turn/steer', codexSteerParams(turn.threadId, turn.turnId, text), { timeoutMs: JSONRPC_SETUP_TIMEOUT_MS });
  }

  cancel(): void {
    if (this.turn) this.cancelTurn(this.turn);
  }

  async close(): Promise<void> {
    this.isClosed = true;
    if (this.turn) this.cancelTurn(this.turn);
    this.finishBackground('closed');
    this.pendingWork.clear();
    if (this.settling) await this.settling;
    const live = this.live;
    this.live = undefined;
    if (!live) return;
    live.peer.rejectPending(new Error('Codex session closed'));
    await live.peer.shutdown();
  }

  private cancelTurn(turn: ActiveTurn): void {
    if (turn.done) return;
    turn.done = true;
    const live = this.live;
    if (live && turn.threadId && turn.turnId) {
      // Let Codex unwind and persist the interrupted turn: up to two seconds
      // for turn/completed before the process is terminated.
      this.settling = new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.turnCompletedWaiter = undefined; if (this.live === live) this.dropLive(turnCancelledError()); resolve(); }, INTERRUPT_SETTLE_MS);
        this.turnCompletedWaiter = () => { clearTimeout(timer); this.turnCompletedWaiter = undefined; resolve(); };
      }).finally(() => { this.settling = undefined; });
      live.peer.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId }, { timeoutMs: INTERRUPT_SETTLE_MS }).catch(() => undefined);
    } else if (live) {
      this.dropLive(turnCancelledError());
    }
    turn.fail(turnCancelledError());
  }

  private dropLive(error: Error): void {
    const live = this.live;
    if (!live) return;
    this.live = undefined;
    this.finishBackground('closed');
    this.pendingWork.clear();
    live.peer.rejectPending(error);
    void live.peer.shutdown();
  }

  private watchdog(onIdle: (afterMs: number) => void): TurnWatchdog {
    return createTurnWatchdog({
      ...(this.idleMs !== undefined ? { idleMs: this.idleMs } : {}),
      ...(this.toolIdleMs !== undefined ? { toolIdleMs: this.toolIdleMs } : {}),
      onIdle,
    });
  }

  /** Open a background turn and hand it to the owner. Without an owner the
   * vendor's out-of-turn work is not surfaced, exactly as before. */
  private openBackground(reason: 'vendor-turn' | 'background-work', vendorTurnId?: string, items?: Map<string, JsonObject>): BackgroundRun | undefined {
    if (!this.onBackgroundTurn || this.isClosed) return undefined;
    if (this.background && !this.background.channel.done) return this.background;
    const channel = new BackgroundTurnChannel('codex-app-server', reason);
    const run: BackgroundRun = {
      channel, observer: channel.observer, lastAgentMessage: '', streamedMessage: '', sawActivity: false,
      items: new Map([...(items ?? [])].filter(([id]) => this.pendingWork.has(`item:${id}`))), output: new Map(), thoughts: new Map(),
      ...(vendorTurnId ? { vendorTurnId } : {}),
    };
    run.watchdog = this.watchdog(() => {
      if (this.background !== run) return;
      // The ceiling ends the background turn, not the server: whatever is
      // still running can report into the next turn.
      this.pendingWork.clear();
      this.finishBackground('idle-timeout');
    });
    for (const key of this.pendingWork.keys()) run.watchdog.toolStarted(key);
    this.background = run;
    try { this.onBackgroundTurn(channel); } catch { /* fail-open-ok: the owner's bookkeeping */ }
    return run;
  }

  private finishBackground(ended: BackgroundTurnEnd): void {
    const run = this.background;
    if (!run) return;
    this.background = undefined;
    run.watchdog?.stop();
    run.channel.finish(ended);
  }

  private settleBackground(): void {
    const run = this.background;
    if (run && !run.vendorTurnId && this.pendingWork.size === 0) this.finishBackground('completed');
  }

  private workStarted(key: string, work: PendingWork, target: Stream | undefined): void {
    if (this.pendingWork.has(key)) return;
    this.pendingWork.set(key, work);
    target?.watchdog?.toolStarted(key);
  }

  private workFinished(key: string, target: Stream | undefined): boolean {
    target?.watchdog?.toolFinished(key);
    return this.pendingWork.delete(key);
  }

  private ensureLive(input: CodexAppServerTurnInput, threadKey: string): LiveServer {
    const key = JSON.stringify([input.binary, input.cwd, input.environment ?? {}, threadKey]);
    if (this.live && !this.live.peer.closed && this.live.key === key) return this.live;
    // Approval policy, sandbox and config are fixed when a thread is opened:
    // changing them means a fresh server that resumes the thread.
    if (this.live) this.dropLive(new Error('Codex app-server restarted'));
    const detached = process.platform !== 'win32';
    const child = this.spawn(input.binary, ['app-server', '--stdio'], {
      cwd: input.cwd, env: { ...process.env, ...input.environment }, stdio: ['pipe', 'pipe', 'pipe'], detached,
    });
    const live: LiveServer = {
      key, initialized: false,
      peer: new JsonRpcPeer(child, {
        label: 'Codex app-server',
        jsonrpcVersion: false,
        detached,
        onRequest: (method, params) => this.serverRequest(method, params),
        onNotification: (method, params) => this.notification(method, params),
        onClose: (error) => {
          if (this.live === live) {
            this.live = undefined;
            this.finishBackground('closed');
            this.pendingWork.clear();
          }
          const turn = this.turn;
          if (!turn || turn.done) return;
          const reason = typeof turn.lastError?.message === 'string' ? new Error(turn.lastError.message) : error;
          turn.fail(reason);
        },
      }),
    };
    this.live = live;
    return live;
  }

  private async flow(turn: ActiveTurn, completion: Promise<void>): Promise<CodexAppServerTurnResult> {
    const { input } = turn;
    const settings = codexPermissionSettings(input.permissionMode);
    const overrides = { ...(input.configOverrides ? { config: input.configOverrides } : {}), ...(input.extraThreadParams ?? {}) };
    const live = this.ensureLive(input, JSON.stringify([settings, overrides]));
    const { peer } = live;
    const setup = { timeoutMs: input.setupTimeoutMs ?? JSONRPC_SETUP_TIMEOUT_MS };
    const stillRunning = (): void => { if (turn.done) throw turnCancelledError(); };
    if (!live.initialized) {
      await peer.request('initialize', { clientInfo: { name: 'clikcode', title: 'ClikCode', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } }, setup);
      peer.notify('initialized');
      live.initialized = true;
      stillRunning();
    }
    const wanted = input.nativeSessionId ?? this.threadId;
    if (!wanted || live.threadId !== wanted) {
      const params = { cwd: input.cwd, model: input.model ?? null, ...settings, ...overrides };
      const threadResult = wanted
        ? await peer.request('thread/resume', { threadId: wanted, ...params }, { ...setup, idleReset: true })
        : await peer.request('thread/start', params, setup);
      stillRunning();
      const thread = (threadResult.thread as JsonObject | undefined) ?? {};
      const threadId = String(thread.id ?? wanted ?? '');
      if (!threadId) throw new Error('Codex app-server did not return a thread id');
      live.threadId = threadId;
    }
    const threadId = live.threadId!;
    turn.threadId = threadId;
    this.threadId = threadId;
    await input.onSessionId?.(threadId);
    stillRunning();
    // The turn ends on Codex's own turn/completed. This is only the ceiling
    // for a server that has stopped talking without saying so.
    turn.watchdog = this.watchdog((afterMs) => turn.fail(turnIdleError('Codex', afterMs)));
    const turnResult = await peer.request('turn/start', {
      threadId,
      input: [
        { type: 'text', text: input.prompt, text_elements: [] },
        ...(input.images ?? []).map((path) => ({ type: 'localImage', path })),
      ],
      cwd: input.cwd, model: input.model ?? null, effort: input.effort ?? null,
    }, setup);
    stillRunning();
    turn.turnId = String(((turnResult.turn as JsonObject) ?? {}).id ?? '');
    if (!turn.turnId) throw new Error('Codex app-server did not return a turn id');
    input.onSteerReady?.((text) => this.turn === turn ? this.steer(text) : Promise.reject(new Error('Codex turn ended')));
    await completion;
    const text = (turn.lastAgentMessage || turn.streamedMessage).trim();
    // Tool-only turns are real work with nothing to say.
    if (!text && !turn.sawActivity) throw new Error('Codex returned no assistant text');
    return { text, nativeSessionId: threadId };
  }

  private serverRequest(method: string, params: JsonObject): Promise<unknown> | undefined {
    const modern = method.endsWith('/requestApproval');
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
    if (!modern && !legacy) return undefined;
    const answer = (accepted: boolean, aborted = false): JsonObject => modern
      ? { decision: aborted ? 'cancel' : accepted ? 'accept' : 'decline' }
      : { decision: aborted ? 'abort' : accepted ? 'approved' : 'denied' };
    return (async () => {
      const turn = this.turn && !this.turn.done ? this.turn : undefined;
      // Out of turn, a vendor turn or a sub-agent still asks the user -- via
      // the background turn, under the permission mode of the last turn.
      const stream: Stream | undefined = turn ?? this.background ?? this.openBackground('vendor-turn');
      if (!stream) return answer(false, true);
      const permissionMode = turn?.input.permissionMode ?? this.lastPermissionMode;
      if (permissionMode === 'bypass') return answer(true);
      // `auto` delegates routine review to Codex's own auto_review reviewer.
      // Whatever still reaches the client is, by construction, something the
      // reviewer escalated -- so the user decides, exactly as in `ask`.
      const fileChange = /fileChange|applyPatch/.test(method);
      const item = typeof params.itemId === 'string' ? stream.items.get(params.itemId) : undefined;
      // Codex is waiting on the user, not wedged.
      const resume = stream.watchdog?.pause();
      try {
        const diff = fileChange ? fileChangeActivity(params.changes ?? params.fileChanges ?? item?.changes).diff : undefined;
        const accepted = await stream.observer.onApproval?.(fileChange ? 'Approve file changes' : 'Approve command', codexApprovalDetail(params, item), diff?.length ? { diff } : undefined) === true;
        return turn?.done ? answer(false, true) : answer(accepted);
      } finally {
        resume?.();
      }
    })();
  }

  /** Where a notification goes: the user's turn while one runs, otherwise a
   * background turn -- opened when the vendor starts a turn of its own, or
   * reports on work a finished turn left running. */
  private targetFor(method: string, params: JsonObject, ours: boolean): Stream | undefined {
    // A stopped turn winding down: what it still says belongs to nobody.
    if (this.turn) return this.turn.done ? undefined : this.turn;
    const turnId = String(((params.turn as JsonObject | undefined) ?? {}).id ?? '');
    const vendorTurn = ours && method === 'turn/started' && turnId ? turnId : undefined;
    if (this.background && !this.background.channel.done) {
      if (vendorTurn) {
        this.background.vendorTurnId = vendorTurn;
        this.background.channel.reason = 'vendor-turn';
      }
      return this.background;
    }
    if (vendorTurn) return this.openBackground('vendor-turn', vendorTurn);
    const childStarted = !ours && method === 'turn/started';
    if ((this.pendingWork.size || childStarted) && CONTENT_NOTIFICATION.test(method)) return this.openBackground('background-work');
    return undefined;
  }

  private notification(method: string, params: JsonObject): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    // Sub-agents run as threads of their own on this same connection. Their
    // turns, messages and tools are theirs: a sub-agent finishing is not the
    // parent's turn/completed, and its prose is not the parent's answer.
    const ours = threadId === undefined || threadId === this.threadId;
    if (method === 'turn/completed' && ours) this.turnCompletedWaiter?.();
    const target = this.targetFor(method, params, ours);
    target?.watchdog?.activity();
    if (!ours) this.otherThread(target, method, params, threadId!);
    else if (target) this.ownThread(target, method, params);
    else this.bookkeeping(undefined, method, params);
    this.settleBackground();
  }

  /** Pending-work bookkeeping for our own thread, whoever is listening. */
  private bookkeeping(target: Stream | undefined, method: string, params: JsonObject): void {
    if (method !== 'item/started' && method !== 'item/completed') return;
    const item = (params.item as JsonObject) ?? {};
    if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
      const key = `agent:${item.agentThreadId}`;
      if (item.kind === 'started' && method === 'item/started') {
        this.workStarted(key, { label: subAgentLabel(item.agentPath) }, target);
        target?.observer.onActivity?.({ kind: 'tool-start', label: subAgentLabel(item.agentPath), agent: true, id: key });
      } else if (item.kind === 'completed' && this.workFinished(key, target)) {
        target?.observer.onActivity?.({ kind: 'tool-done', label: subAgentLabel(item.agentPath), agent: true, id: key });
      }
      return;
    }
    if (typeof item.id !== 'string') return;
    const key = `item:${item.id}`;
    if (method === 'item/started') {
      if (codexActivityForItem(item, false)?.kind === 'tool-start') {
        this.workStarted(key, { label: String(item.type), ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}) }, target);
      }
    } else this.workFinished(key, target);
  }

  /** A sub-agent thread: one row per sub-agent, open while it works. */
  private otherThread(target: Stream | undefined, method: string, params: JsonObject, threadId: string): void {
    const key = `agent:${threadId}`;
    if (method === 'turn/started') {
      const known = this.pendingWork.get(key);
      if (!known) {
        this.workStarted(key, { label: 'subagent' }, target);
        target?.observer.onActivity?.({ kind: 'tool-start', label: 'subagent', agent: true, id: key });
      }
    } else if (method === 'turn/completed') {
      const known = this.pendingWork.get(key);
      if (known && this.workFinished(key, target)) {
        const failed = ((params.turn as JsonObject | undefined) ?? {}).status === 'failed';
        target?.observer.onActivity?.({ kind: failed ? 'tool-error' : 'tool-done', label: known.label, agent: true, id: key });
      }
    }
  }

  private ownThread(target: Stream, method: string, params: JsonObject): void {
    const observer = target.observer;
    this.bookkeeping(target, method, params);
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      target.streamedMessage += params.delta;
      observer.onResponseDelta?.(params.delta);
      observer.onPhase?.('generating response');
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = (params.item as JsonObject) ?? {};
      if (typeof item.id === 'string') {
        if (method === 'item/started') target.items.set(item.id, item);
        else {
          target.items.delete(item.id);
          target.output.delete(item.id);
          target.thoughts.delete(item.id);
          target.thoughts.delete(`${item.id}:raw`);
        }
      }
      if (item.type === 'contextCompaction' && method === 'item/completed') this.compacted(target);
      if (item.type === 'agentMessage' && method === 'item/started') {
        if (target.streamedMessage) observer.onResponseDelta?.('\n\n');
        target.streamedMessage = '';
      }
      if (item.type === 'agentMessage' && method === 'item/completed' && typeof item.text === 'string') {
        target.lastAgentMessage = item.text;
        // Deltas are the normal path. Some app-server/provider combinations
        // can still complete an item without publishing them; surface that
        // text immediately instead of leaving the UI blank until the turn is
        // persisted. If only a suffix was missed, append just that suffix.
        const catchup = completedAgentMessageUpdate(target.streamedMessage, item.text);
        if (catchup) observer.onResponseDelta?.(catchup.text, catchup.mode);
        target.streamedMessage = item.text;
      }
      const activity = codexActivityForItem(item, method === 'item/completed');
      if (activity) {
        if (activity.kind !== 'thinking') target.sawActivity = true;
        observer.onActivity?.(activity);
      }
    } else if (/^item\/(commandExecution|fileChange)\/outputDelta$/.test(method) && typeof params.delta === 'string') {
      this.outputDelta(target, String(params.itemId ?? ''), params.delta);
    } else if (/^item\/reasoning\/(summaryTextDelta|textDelta)$/.test(method) && typeof params.delta === 'string') {
      // Each delta is a fragment; the thought is all of them, per item.
      const id = `${String(params.itemId ?? '')}${method.endsWith('/textDelta') ? ':raw' : ''}`;
      const thought = `${target.thoughts.get(id) ?? ''}${params.delta}`;
      target.thoughts.set(id, thought);
      observer.onThought?.(thought, id);
    } else if (method === 'item/reasoning/summaryPartAdded') {
      // A new section of the same summary.
      const id = String(params.itemId ?? '');
      const thought = target.thoughts.get(id);
      if (thought) target.thoughts.set(id, `${thought}\n\n`);
    } else if (method === 'item/fileChange/patchUpdated' && params.changes) {
      // The patch as it stands while the edit is still being made.
      const itemId = String(params.itemId ?? '');
      if (itemId) {
        target.sawActivity = true;
        observer.onActivity?.({ kind: 'tool-start', id: itemId, ...fileChangeActivity(params.changes) });
      }
    } else if (/^(warning|configWarning|deprecationNotice|guardianWarning)$/.test(method)) {
      // Codex's own word to the user: a misconfiguration, a deprecation, a
      // safety warning. It was dropped.
      const message = [params.message, params.summary, params.details].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (message) observer.onNotice?.(`Codex: ${message.trim()}`);
    } else if (method === 'item/mcpToolCall/progress' && typeof params.message === 'string') {
      this.progress(target, String(params.itemId ?? ''), { output: [String(params.message)] });
    } else if (method === 'turn/diff/updated') {
      // Deliberately not shown: it is the turn's changes aggregated, and every
      // fileChange item already shows its own paths and diff on its own row.
    } else if (method === 'model/rerouted') {
      // A different model is answering than the one asked for.
      const reason = typeof params.reason === 'string' ? ` (${params.reason})` : '';
      observer.onNotice?.(`Codex moved this turn from ${String(params.fromModel ?? 'the chosen model')} to ${String(params.toModel ?? 'another model')}${reason}`);
    } else if (method === 'thread/compacted') {
      this.compacted(target);
    } else if (method === 'turn/plan/updated') {
      observer.onPlan?.(codexPlanEntries(params), typeof params.explanation === 'string' ? params.explanation : undefined);
    } else if (/token_?usage|token_count/i.test(method)) {
      const reading = asRecord(params.tokenUsage) ?? asRecord(params.token_usage) ?? asRecord(params.info);
      const turnUsage = reading ? codexTurnUsage(reading, target.usageStart) : undefined;
      if (turnUsage) {
        target.usageStart = turnUsage.start;
        observer.onUsage?.(turnUsage.usage);
      }
    } else if (method === 'account/rateLimits/updated') {
      observer.onRateLimits?.(params.rateLimits);
    } else if (method === 'turn/completed') {
      const completedTurn = (params.turn as JsonObject) ?? {};
      if (target === this.background) {
        if (completedTurn.id === this.background.vendorTurnId) delete this.background.vendorTurnId;
        return;
      }
      const turn = target as ActiveTurn;
      // Only the turn we started ends it (a late turn/completed of an earlier
      // turn must not end this one).
      if (turn.turnId && completedTurn.id !== undefined && completedTurn.id !== turn.turnId) return;
      if (completedTurn.status === 'failed') {
        const error = (completedTurn.error as JsonObject | undefined) ?? turn.lastError;
        if (error) turn.lastError = error;
        return turn.complete(Object.assign(new Error(String(error?.message ?? 'Codex turn failed')), { codexTurnFailed: true }));
      }
      if (completedTurn.status === 'interrupted') return turn.complete(turnCancelledError());
      const stopReason = turnStopReason(completedTurn.status);
      if (stopReason) observer.onUsage?.({ stopReason });
      turn.complete();
    } else if (method === 'error') {
      const error = (params.error as JsonObject) ?? {};
      // Say why it is retrying, not only that it is.
      if (params.willRetry === true) observer.onPhase?.(typeof error.message === 'string' && error.message ? `retrying: ${error.message.split('\n')[0]!.slice(0, 120)}` : 'retrying');
      else if (typeof error.message === 'string') target.lastError = error;
    }
  }

  /** Live command output. Rate-limited per item: every consumer of activity
   * events persists or repaints, and a build can emit thousands of deltas. */
  private outputDelta(target: Stream, itemId: string, delta: string): void {
    if (!itemId) return;
    const entry = target.output.get(itemId) ?? { text: '', emittedAt: 0 };
    entry.text = `${entry.text}${delta}`.slice(-OUTPUT_BUFFER_LIMIT);
    target.output.set(itemId, entry);
    const now = Date.now();
    if (now - entry.emittedAt < OUTPUT_EMIT_INTERVAL_MS) return;
    entry.emittedAt = now;
    this.progress(target, itemId, activityOutput(entry.text, { tail: true }));
  }

  /** What a running item has to show so far, on its own row. */
  private progress(target: Stream, itemId: string, output: Pick<HarnessActivityEvent, 'output' | 'outputOmitted' | 'outputTail'>): void {
    if (!itemId) return;
    const item = target.items.get(itemId);
    const activity = item ? codexActivityForItem(item, false) : undefined;
    target.sawActivity = true;
    target.observer.onActivity?.({
      kind: 'tool-start', label: activity?.label ?? 'command', id: itemId, ...output,
      ...(activity?.category ? { category: activity.category } : {}),
      ...(activity?.agent ? { agent: activity.agent } : {}),
    });
  }

  /** The conversation was compacted to fit the model's window: the model now
   * works from a summary of what came before. Said once per turn. */
  private compacted(target: Stream): void {
    if (target.compacted) return;
    target.compacted = true;
    target.observer.onNotice?.('Codex compacted the conversation to fit its context window');
  }
}

/** One app-server kept alive across turns: initialize once, open or resume the
 * thread once, then one turn/start per turn. If the child dies (or its thread
 * settings change) the next turn respawns and resumes the thread. */
export function createCodexSession(options: CodexSessionOptions = {}): CodexSession {
  return new CodexSessionImpl(options);
}

/** One Codex turn over the documented app-server JSONL protocol. Unlike
 * `codex exec --json`, app-server publishes real agent-message deltas and
 * server-initiated approval requests, both of which a rich terminal client
 * must handle to preserve streaming and permission semantics together. */
export async function runCodexAppServerTurn(input: CodexAppServerTurnInput, options: CodexSessionOptions = {}): Promise<CodexAppServerTurnResult> {
  const session = createCodexSession(options);
  try {
    return await session.runTurn(input);
  } finally {
    // Shutdown is graceful (up to seconds); the caller already has its answer.
    void session.close().catch(() => undefined);
  }
}

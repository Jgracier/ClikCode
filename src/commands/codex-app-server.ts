import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnPortable } from './spawn-portable.js';
import { JSONRPC_SETUP_TIMEOUT_MS, JsonRpcPeer } from './jsonrpc-peer.js';
import type { AiHarnessPermissionMode, HarnessActivityEvent } from './types.js';
import type { HarnessPlanEntry, HarnessTurnObserver } from './harness-turn-observer.js';

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

export type CodexErrorKind = 'quota' | 'auth' | 'other';
export type CodexSpawn = (binary: string, argv: readonly string[], options: SpawnOptions) => ChildProcess;

export interface CodexSession {
  runTurn(input: CodexAppServerTurnInput): Promise<CodexAppServerTurnResult>;
  /** Steer the active turn. Rejects when no turn is running. */
  steer(text: string): Promise<void>;
  /** Interrupt the active turn; the child survives if it acknowledges in 2s. */
  cancel(): void;
  close(): Promise<void>;
}

export interface CodexSessionOptions { spawn?: CodexSpawn }

export interface CodexAppServerTurnResult {
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

const OUTPUT_LINE_CAP = 20;

function outputTail(text: string): string[] {
  const trimmed = text.replace(/\r?\n$/, '');
  return trimmed ? trimmed.split(/\r?\n/).slice(-OUTPUT_LINE_CAP) : [];
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
  if (type === 'commandExecution') {
    const aggregated = completed && typeof item.aggregatedOutput === 'string' ? outputTail(item.aggregatedOutput) : undefined;
    return {
      kind: completed ? completedKind : 'tool-start', label: codexCommandText(item.command) ?? 'command', ...(id ? { id } : {}),
      ...(aggregated?.length ? { output: aggregated } : {}),
    };
  }
  if (type === 'fileChange') return { kind: completed ? completedKind : 'tool-start', label: 'files updated', ...(id ? { id } : {}) };
  if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'collabAgentToolCall') {
    return { kind: completed ? completedKind : 'tool-start', label: String(item.tool ?? item.server ?? 'tool'), ...(id ? { id } : {}) };
  }
  if (type === 'webSearch') return { kind: completed ? completedKind : 'tool-start', label: 'web search', ...(id ? { id } : {}) };
  if (type === 'reasoning' && completed) {
    const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === 'string').join(' ') : '';
    if (summary) return { kind: 'thinking', label: summary.replace(/\s+/g, ' ').slice(0, 140) };
  }
  return undefined;
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
export function codexErrorKind(error: unknown): { errorKind: CodexErrorKind; statusCode?: number } {
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
export function codexApprovalDetail(params: JsonObject, item?: JsonObject): string {
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

export function codexPlanEntries(params: JsonObject): HarnessPlanEntry[] {
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
const cancelledError = (): Error => Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' });
const isCancelled = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_TURN_CANCELLED';

interface LiveServer {
  peer: JsonRpcPeer;
  key: string;
  initialized: boolean;
  threadId?: string;
}

interface ActiveTurn {
  input: CodexAppServerTurnInput;
  done: boolean;
  threadId?: string;
  turnId?: string;
  lastAgentMessage: string;
  streamedMessage: string;
  sawActivity: boolean;
  lastError?: JsonObject;
  items: Map<string, JsonObject>;
  output: Map<string, { text: string; emittedAt: number }>;
  complete: (error?: Error) => void;
  fail: (error: Error) => void;
}

class CodexSessionImpl implements CodexSession {
  private live?: LiveServer;
  private turn?: ActiveTurn;
  private settling?: Promise<void>;
  private turnCompletedWaiter?: () => void;
  private threadId?: string;
  private isClosed = false;
  private readonly spawn: CodexSpawn;

  constructor(options: CodexSessionOptions) {
    this.spawn = options.spawn ?? ((binary, argv, spawnOptions) => spawnPortable(binary, [...argv], spawnOptions));
  }

  async runTurn(input: CodexAppServerTurnInput): Promise<CodexAppServerTurnResult> {
    if (this.isClosed) throw new Error('Codex session is closed');
    if (this.turn) throw new Error('Codex session already has an active turn');
    let fail!: (error: Error) => void;
    let complete!: (error?: Error) => void;
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    failure.catch(() => undefined);
    const completion = new Promise<void>((resolve, reject) => { complete = (error) => error ? reject(error) : resolve(); });
    completion.catch(() => undefined);
    const turn: ActiveTurn = {
      input, done: false, lastAgentMessage: '', streamedMessage: '', sawActivity: false,
      items: new Map(), output: new Map(), complete, fail,
    };
    this.turn = turn;
    const onAbort = (): void => this.cancelTurn(turn);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (this.settling) await this.settling;
      if (input.signal?.aborted) throw cancelledError();
      const flow = this.flow(turn, completion);
      flow.catch(() => undefined);
      return await Promise.race([flow, failure]);
    } catch (error) {
      const failureError = error instanceof Error ? error : new Error(String(error));
      if (!isCancelled(failureError)) {
        // Prefer the server's structured error over the transport's message.
        Object.assign(failureError, codexErrorKind(turn.lastError ?? failureError));
        // A failed *turn* leaves a healthy server; anything else is unknown.
        if (!(failureError as { codexTurnFailed?: boolean }).codexTurnFailed) this.dropLive(failureError);
      }
      throw failureError;
    } finally {
      turn.done = true;
      input.onSteerReady?.(undefined);
      input.signal?.removeEventListener('abort', onAbort);
      if (this.turn === turn) this.turn = undefined;
      // A turn/steer in flight when the turn ends is never answered.
      this.live?.peer.rejectPending(new Error('Codex turn ended'), (method) => method !== 'turn/interrupt');
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
        const timer = setTimeout(() => { this.turnCompletedWaiter = undefined; if (this.live === live) this.dropLive(cancelledError()); resolve(); }, INTERRUPT_SETTLE_MS);
        this.turnCompletedWaiter = () => { clearTimeout(timer); this.turnCompletedWaiter = undefined; resolve(); };
      }).finally(() => { this.settling = undefined; });
      live.peer.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId }, { timeoutMs: INTERRUPT_SETTLE_MS }).catch(() => undefined);
    } else if (live) {
      this.dropLive(cancelledError());
    }
    turn.fail(cancelledError());
  }

  private dropLive(error: Error): void {
    const live = this.live;
    if (!live) return;
    this.live = undefined;
    live.peer.rejectPending(error);
    void live.peer.shutdown();
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
          if (this.live === live) this.live = undefined;
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
    const stillRunning = (): void => { if (turn.done) throw cancelledError(); };
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
      const turn = this.turn;
      if (!turn || turn.done) return answer(false, true);
      if (turn.input.permissionMode === 'bypass') return answer(true);
      // `auto` delegates routine review to Codex's own auto_review reviewer.
      // Whatever still reaches the client is, by construction, something the
      // reviewer escalated -- so the user decides, exactly as in `ask`.
      const fileChange = /fileChange|applyPatch/.test(method);
      const item = typeof params.itemId === 'string' ? turn.items.get(params.itemId) : undefined;
      const accepted = await turn.input.onApproval?.(fileChange ? 'Approve file changes' : 'Approve command', codexApprovalDetail(params, item)) === true;
      return turn.done ? answer(false, true) : answer(accepted);
    })();
  }

  private notification(method: string, params: JsonObject): void {
    if (method === 'turn/completed') this.turnCompletedWaiter?.();
    const turn = this.turn;
    if (!turn || turn.done) return;
    const { input } = turn;
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      turn.streamedMessage += params.delta;
      input.onResponseDelta?.(params.delta);
      input.onPhase?.('generating response');
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = (params.item as JsonObject) ?? {};
      if (typeof item.id === 'string') {
        if (method === 'item/started') turn.items.set(item.id, item);
        else { turn.items.delete(item.id); turn.output.delete(item.id); }
      }
      if (item.type === 'agentMessage' && method === 'item/started') {
        if (turn.streamedMessage) input.onResponseDelta?.('\n\n');
        turn.streamedMessage = '';
      }
      if (item.type === 'agentMessage' && method === 'item/completed' && typeof item.text === 'string') {
        turn.lastAgentMessage = item.text;
        // Deltas are the normal path. Some app-server/provider combinations
        // can still complete an item without publishing them; surface that
        // text immediately instead of leaving the UI blank until the turn is
        // persisted. If only a suffix was missed, append just that suffix.
        const catchup = completedAgentMessageUpdate(turn.streamedMessage, item.text);
        if (catchup) input.onResponseDelta?.(catchup.text, catchup.mode);
        turn.streamedMessage = item.text;
      }
      const activity = codexActivityForItem(item, method === 'item/completed');
      if (activity) {
        if (activity.kind !== 'thinking') turn.sawActivity = true;
        input.onActivity?.(activity);
      }
    } else if (/^item\/(commandExecution|fileChange)\/outputDelta$/.test(method) && typeof params.delta === 'string') {
      this.outputDelta(turn, String(params.itemId ?? ''), params.delta);
    } else if (/^item\/reasoning\/(summaryTextDelta|textDelta)$/.test(method) && typeof params.delta === 'string') {
      input.onThought?.(params.delta);
    } else if (method === 'turn/plan/updated') {
      input.onPlan?.(codexPlanEntries(params), typeof params.explanation === 'string' ? params.explanation : undefined);
    } else if (/token_?usage|token_count/i.test(method)) {
      const usage = params.tokenUsage ?? params.token_usage ?? params.usage ?? params.info ?? params;
      if (usage && typeof usage === 'object') input.onUsage?.(usage as Record<string, unknown>);
    } else if (method === 'account/rateLimits/updated') {
      input.onRateLimits?.(params.rateLimits);
    } else if (method === 'turn/completed') {
      const completedTurn = (params.turn as JsonObject) ?? {};
      if (completedTurn.status === 'failed') {
        const error = (completedTurn.error as JsonObject | undefined) ?? turn.lastError;
        if (error) turn.lastError = error;
        return turn.complete(Object.assign(new Error(String(error?.message ?? 'Codex turn failed')), { codexTurnFailed: true }));
      }
      if (completedTurn.status === 'interrupted') return turn.complete(cancelledError());
      turn.complete();
    } else if (method === 'error') {
      const error = (params.error as JsonObject) ?? {};
      if (params.willRetry === true) input.onPhase?.('retrying');
      else if (typeof error.message === 'string') turn.lastError = error;
    }
  }

  /** Live command output. Rate-limited per item: every consumer of activity
   * events persists or repaints, and a build can emit thousands of deltas. */
  private outputDelta(turn: ActiveTurn, itemId: string, delta: string): void {
    if (!itemId) return;
    const entry = turn.output.get(itemId) ?? { text: '', emittedAt: 0 };
    entry.text = `${entry.text}${delta}`.slice(-OUTPUT_BUFFER_LIMIT);
    turn.output.set(itemId, entry);
    const now = Date.now();
    if (now - entry.emittedAt < OUTPUT_EMIT_INTERVAL_MS) return;
    entry.emittedAt = now;
    const item = turn.items.get(itemId);
    const label = item ? codexActivityForItem(item, false)?.label ?? 'command' : 'command';
    turn.sawActivity = true;
    turn.input.onActivity?.({ kind: 'tool-start', label, id: itemId, output: outputTail(entry.text) });
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

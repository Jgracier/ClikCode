/** Shared Agent Client Protocol transport. Providers that publish ACP can use
 * this one lifecycle/stream/approval implementation instead of accumulating
 * another vendor-shaped JSON parser. The existing CLI adapter remains the
 * compatibility fallback for products without ACP. */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { AiHarnessPermissionMode } from '../definition.js';
import type { HarnessActivityEvent } from '../prompter.js';
import type { HarnessAvailableCommand, HarnessPlanEntry, HarnessTurnObserver } from '../events/turn-observer.js';
import { spawnPortable } from './spawn.js';
import { JSONRPC_SETUP_TIMEOUT_MS, JsonRpcPeer } from './jsonrpc-peer.js';

type Json = Record<string, any>;

/** Tool kinds that cannot change the workspace or run code. `auto` approves
 * only these; everything else still reaches the user. */
const READ_LIKE_TOOL_KINDS: ReadonlySet<string> = new Set(['read', 'search', 'think', 'fetch']);
const DIFF_LINE_CAP = 200;
const OUTPUT_LINE_CAP = 20;
const DETAIL_LINE_CAP = 12;
const CANCEL_SETTLE_MS = 2000;

type AcpSpawn = (binary: string, argv: readonly string[], options: SpawnOptions) => ChildProcess;

export interface AcpTurnInput extends HarnessTurnObserver {
  binary: string;
  command: string;
  cwd: string;
  prompt: string;
  nativeSessionId?: string;
  /** False when `nativeSessionId` was minted locally and the agent has never
   * seen it: start with session/new instead of a resume that must fail.
   * Defaults to true whenever `nativeSessionId` is given. */
  sessionCreated?: boolean;
  environment: Readonly<Record<string, string>>;
  permissionMode: AiHarnessPermissionMode;
  model?: string | null;
  effort?: string | null;
  /** Local image paths, sent as ACP image blocks when the agent advertises
   * `promptCapabilities.image`. Otherwise the turn fails before the prompt
   * with `acpSafeToFallback` so the caller can use its image-capable CLI. */
  images?: readonly string[];
  /** Catalog-driven ACP mode argv (harnessAcpLaunch().modeArgv). When given,
   * no model/effort/permission flags are derived locally: pass them as
   * `extraArgv` (harnessAcpLaunch().optionArgv). Absent: the local table. */
  argv?: readonly string[];
  /** Where options go relative to `argv`. Default: `after` for droid (its
   * flags belong to the `exec` subcommand), `before` for everything else. */
  optionPlacement?: 'before' | 'after';
  /** Per-harness options. With `argv` these are the only options; without it
   * they are appended to the locally derived model/effort/permission flags. */
  extraArgv?: readonly string[];
  /** Setup request timeout (initialize, session/new|resume|load). */
  setupTimeoutMs?: number;
  signal?: AbortSignal;
}

interface AcpTurnResult { text: string; nativeSessionId: string }

export interface AcpSession {
  runTurn(input: AcpTurnInput): Promise<AcpTurnResult>;
  /** Cancel the active turn, if any. The child stays alive when it honours
   * session/cancel within two seconds. */
  cancel(): void;
  close(): Promise<void>;
}

interface AcpSessionOptions { spawn?: AcpSpawn }

export function acpResponseDelta(update: Json): string | undefined {
  return update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string'
    ? update.content.text : undefined;
}

function acpThoughtDelta(update: Json): string | undefined {
  return update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string'
    ? update.content.text : undefined;
}

function cappedLines(text: string, cap: number): string[] {
  if (!text) return [];
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  return lines.length > cap ? [...lines.slice(0, cap), `... ${lines.length - cap} more lines`] : lines;
}

export function acpActivityEvent(update: Json): HarnessActivityEvent | undefined {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return undefined;
  const status = String(update.status);
  const completed = ['completed', 'failed'].includes(status);
  const content: Json[] = Array.isArray(update.content) ? update.content : [];
  const diffEntry = content.find((entry) => entry?.type === 'diff');
  // A new file has no old text. Rendering `removed: ['']` would show a phantom
  // deleted blank line, so an absent side is an empty list.
  const diff = diffEntry
    ? { removed: cappedLines(String(diffEntry.oldText ?? ''), DIFF_LINE_CAP), added: cappedLines(String(diffEntry.newText ?? ''), DIFF_LINE_CAP) }
    : undefined;
  const outputText = content
    .flatMap((entry) => entry?.type === 'content' && entry.content?.type === 'text' && typeof entry.content.text === 'string' ? [entry.content.text as string] : [])
    .join('\n');
  const output = outputText.trim() ? outputText.replace(/\r?\n$/, '').split(/\r?\n/).slice(-OUTPUT_LINE_CAP) : undefined;
  return {
    kind: status === 'failed' ? 'tool-error' : completed ? 'tool-done' : 'tool-start',
    label: String(update.title ?? update.name ?? 'tool'),
    ...(typeof update.toolCallId === 'string' ? { id: update.toolCallId } : {}),
    ...(output ? { output } : {}),
    ...(diff ? { diff } : {}),
  };
}

function acpPlanEntries(update: Json): HarnessPlanEntry[] | undefined {
  if (update.sessionUpdate !== 'plan' || !Array.isArray(update.entries)) return undefined;
  return update.entries.flatMap((entry: Json) => typeof entry?.content === 'string'
    ? [{ content: entry.content, status: String(entry.status ?? 'pending'), ...(typeof entry.priority === 'string' ? { priority: entry.priority } : {}) }]
    : []);
}

function acpAvailableCommands(update: Json): HarnessAvailableCommand[] | undefined {
  if (update.sessionUpdate !== 'available_commands_update' || !Array.isArray(update.availableCommands)) return undefined;
  return update.availableCommands.flatMap((entry: Json) => typeof entry?.name === 'string'
    ? [{
      name: entry.name,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(typeof entry.input?.hint === 'string' ? { hint: entry.input.hint } : {}),
    }]
    : []);
}

/** What the user is actually approving: the command, the path, the first
 * lines of the change. A bare tool title is not an informed decision. */
export function acpApprovalDetail(toolCall: Json | undefined): string | undefined {
  if (!toolCall) return undefined;
  const raw: Json = toolCall.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {};
  const lines: string[] = [];
  const command = Array.isArray(raw.command) ? raw.command.map(String).join(' ')
    : typeof raw.command === 'string' ? raw.command
      : typeof raw.cmd === 'string' ? raw.cmd : undefined;
  if (command) lines.push(`$ ${command}`);
  if (typeof raw.cwd === 'string') lines.push(`cwd: ${raw.cwd}`);
  const paths = new Set<string>();
  for (const key of ['path', 'file_path', 'filePath', 'abs_path', 'url']) if (typeof raw[key] === 'string') paths.add(raw[key]);
  if (Array.isArray(toolCall.locations)) for (const location of toolCall.locations) if (typeof location?.path === 'string') paths.add(location.path);
  const content: Json[] = Array.isArray(toolCall.content) ? toolCall.content : [];
  for (const entry of content) if (entry?.type === 'diff' && typeof entry.path === 'string') paths.add(entry.path);
  for (const path of paths) lines.push(path);
  for (const entry of content) {
    if (entry?.type !== 'diff') continue;
    const removed = cappedLines(String(entry.oldText ?? ''), 4).map((line) => `- ${line}`);
    const added = cappedLines(String(entry.newText ?? ''), 6).map((line) => `+ ${line}`);
    lines.push(...removed, ...added);
    break;
  }
  if (!lines.length) return undefined;
  return lines.length > DETAIL_LINE_CAP ? [...lines.slice(0, DETAIL_LINE_CAP), '...'].join('\n') : lines.join('\n');
}

interface AcpPermissionPlan {
  /** `allow` answers without the user; `ask` must go through onApproval. */
  action: 'allow' | 'ask';
  /** Option selected when allowed/approved. */
  allowOptionId?: string;
  /** True when approving would grant a persistent (`allow_always`) rule,
   * because the agent offered nothing narrower. Only the user may pick it. */
  allowIsPersistent: boolean;
  /** Option selected when refused. Absent means answer `cancelled`. */
  rejectOptionId?: string;
}

/** Pure permission policy. `bypass` allows, `ask` asks, and `auto` allows
 * only read-like tools. No mode ever selects `allow_always` by itself. */
function acpPermissionPlan(mode: AiHarnessPermissionMode, params: Json): AcpPermissionPlan {
  const options: Json[] = Array.isArray(params.options) ? params.options : [];
  const kindOf = (option: Json): string => String(option?.kind ?? '');
  const once = options.find((option) => kindOf(option) === 'allow_once')
    ?? options.find((option) => kindOf(option).startsWith('allow') && kindOf(option) !== 'allow_always');
  const always = options.find((option) => kindOf(option) === 'allow_always');
  const reject = options.find((option) => kindOf(option) === 'reject_once')
    ?? options.find((option) => kindOf(option).startsWith('reject') && kindOf(option) !== 'reject_always')
    ?? options.find((option) => kindOf(option).startsWith('reject'));
  const allowOption = once ?? always;
  const readLike = READ_LIKE_TOOL_KINDS.has(String(params.toolCall?.kind ?? ''));
  const automatic = once !== undefined && (mode === 'bypass' || (mode === 'auto' && readLike));
  return {
    action: automatic ? 'allow' : 'ask',
    ...(allowOption?.optionId !== undefined ? { allowOptionId: String(allowOption.optionId) } : {}),
    allowIsPersistent: once === undefined && always !== undefined,
    ...(reject?.optionId !== undefined ? { rejectOptionId: String(reject.optionId) } : {}),
  };
}

/** Full child argv for one ACP launch, or undefined without an adapter.
 *
 * The argv comes from the catalog (`harnessAcpLaunch`), which already derives
 * the mode flag, the model flag, the effort flag and the permission flags from
 * the harness's own entry. A second copy of those flags lived here as a
 * fallback for callers that passed no argv -- four harnesses' worth of
 * `command === 'cline' ? ['--thinking', effort]`, drifting from the catalog
 * entry describing the same flag. There is one description of a harness now,
 * and it is the catalog. */
export function acpSpawnArgv(
  input: Pick<AcpTurnInput, 'command' | 'argv' | 'optionPlacement' | 'extraArgv'>,
): string[] | undefined {
  const argv = input.argv;
  if (!argv) return undefined;
  const options = [...(input.extraArgv ?? [])];
  const placement = input.optionPlacement ?? 'before';
  return placement === 'after' ? [...argv, ...options] : [...options, ...argv];
}

const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

async function acpImageBlock(path: string): Promise<Json> {
  const data = await readFile(path);
  return { type: 'image', mimeType: IMAGE_MIME[extname(path).toLowerCase()] ?? 'image/png', data: data.toString('base64') };
}

const cancelledError = (): Error => Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' });
const isCancelled = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_TURN_CANCELLED';

interface LiveAgent {
  peer: JsonRpcPeer;
  key: string;
  capabilities?: Json;
  /** Session currently loaded in this child; it needs no resume/load. */
  sessionId?: string;
}

interface ActiveTurn {
  input: AcpTurnInput;
  text: string;
  sawActivity: boolean;
  promptStarted: boolean;
  done: boolean;
  sessionId?: string;
  prompt?: Promise<unknown>;
  fail: (error: Error) => void;
}

class AcpSessionImpl implements AcpSession {
  private live?: LiveAgent;
  private turn?: ActiveTurn;
  private settling?: Promise<void>;
  private sessionId?: string;
  private isClosed = false;
  private readonly spawn: AcpSpawn;

  constructor(options: AcpSessionOptions) {
    this.spawn = options.spawn ?? ((binary, argv, spawnOptions) => spawnPortable(binary, [...argv], spawnOptions));
  }

  async runTurn(input: AcpTurnInput): Promise<AcpTurnResult> {
    if (this.isClosed) throw new Error(`${input.command} ACP session is closed`);
    if (this.turn) throw new Error(`${input.command} ACP session already has an active turn`);
    const argv = acpSpawnArgv(input);
    if (!argv) throw new Error(`${input.command} has no ACP adapter`);
    let fail!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    failure.catch(() => undefined);
    const turn: ActiveTurn = { input, text: '', sawActivity: false, promptStarted: false, done: false, fail };
    this.turn = turn;
    const onAbort = (): void => this.cancelTurn(turn);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (this.settling) await this.settling;
      if (input.signal?.aborted) throw cancelledError();
      const flow = this.flow(turn, argv);
      flow.catch(() => undefined);
      return await Promise.race([flow, failure]);
    } catch (error) {
      const failureError = error instanceof Error ? error : new Error(String(error));
      // A cancelled turn must never be retried on the CLI fallback.
      Object.assign(failureError, { acpSafeToFallback: !turn.promptStarted && !isCancelled(failureError) });
      // After a failure the child's protocol state is unknown. Drop it; the
      // next turn respawns and resumes. Cancellation settles on its own path.
      if (!isCancelled(failureError)) this.dropLive(failureError);
      throw failureError;
    } finally {
      turn.done = true;
      input.signal?.removeEventListener('abort', onAbort);
      if (this.turn === turn) this.turn = undefined;
      this.live?.peer.rejectPending(new Error(`${input.command} ACP turn ended`), (method) => method !== 'session/prompt');
    }
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
    live.peer.rejectPending(new Error('ACP session closed'));
    await live.peer.shutdown();
  }

  private cancelTurn(turn: ActiveTurn): void {
    if (turn.done) return;
    turn.done = true;
    const live = this.live;
    if (live && turn.prompt && turn.sessionId) {
      // The agent answers the prompt with stopReason `cancelled` once it has
      // unwound. Give it two seconds so the session stays resumable.
      live.peer.notify('session/cancel', { sessionId: turn.sessionId });
      const prompt = turn.prompt;
      this.settling = new Promise<void>((resolve) => {
        const timer = setTimeout(() => { if (this.live === live) this.dropLive(cancelledError()); resolve(); }, CANCEL_SETTLE_MS);
        void prompt.then(() => undefined, () => undefined).then(() => { clearTimeout(timer); resolve(); });
      }).finally(() => { this.settling = undefined; });
    } else if (live) {
      // Mid-setup there is nothing to cancel politely.
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

  private ensureLive(input: AcpTurnInput, argv: readonly string[]): LiveAgent {
    const key = JSON.stringify([input.binary, argv, input.cwd, input.environment]);
    if (this.live && !this.live.peer.closed && this.live.key === key) return this.live;
    // Model, effort and permission flags are launch arguments: a change means
    // a new child, which then resumes the same session.
    if (this.live) this.dropLive(new Error(`${input.command} ACP restarted`));
    const detached = process.platform !== 'win32';
    const child = this.spawn(input.binary, argv, {
      cwd: input.cwd, env: { ...process.env, ...input.environment }, stdio: ['pipe', 'pipe', 'pipe'], detached,
    });
    const live: LiveAgent = {
      key,
      peer: new JsonRpcPeer(child, {
        label: `${input.command} ACP`,
        detached,
        onRequest: (method, params) => method === 'session/request_permission' ? this.permission(params) : undefined,
        onNotification: (method, params) => { if (method === 'session/update') this.update(params); },
        onClose: (error) => {
          if (this.live === live) this.live = undefined;
          if (this.turn && !this.turn.done) this.turn.fail(error);
        },
      }),
    };
    this.live = live;
    return live;
  }

  private async flow(turn: ActiveTurn, argv: readonly string[]): Promise<AcpTurnResult> {
    const { input } = turn;
    const live = this.ensureLive(input, argv);
    const { peer } = live;
    const setup = { timeoutMs: input.setupTimeoutMs ?? JSONRPC_SETUP_TIMEOUT_MS };
    const stillRunning = (): void => { if (turn.done) throw cancelledError(); };
    if (!live.capabilities) {
      const initialized = await peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'clikcode', title: 'ClikCode', version: '1' },
      }, setup);
      live.capabilities = (initialized.agentCapabilities as Json | undefined) ?? {};
      stillRunning();
    }
    const capabilities = live.capabilities;
    const images = input.images ?? [];
    if (images.length && capabilities.promptCapabilities?.image !== true) {
      throw new Error(`${input.command} ACP does not accept image prompts`);
    }
    const wanted = input.nativeSessionId ?? this.sessionId;
    const created = input.nativeSessionId ? input.sessionCreated !== false : wanted !== undefined;
    if (wanted && created) {
      if (live.sessionId !== wanted) {
        // session/load streams the whole history before it answers, so its
        // timeout is an idle window rather than a wall-clock limit.
        const loading = { ...setup, idleReset: true };
        if (capabilities.sessionCapabilities?.resume) await peer.request('session/resume', { sessionId: wanted, cwd: input.cwd, mcpServers: [] }, loading);
        else if (capabilities.loadSession) await peer.request('session/load', { sessionId: wanted, cwd: input.cwd, mcpServers: [] }, loading);
        else throw new Error(`${input.command} ACP cannot load sessions`);
        stillRunning();
        live.sessionId = wanted;
      }
      turn.sessionId = wanted;
    } else {
      const started = await peer.request('session/new', { cwd: input.cwd, mcpServers: [] }, setup);
      stillRunning();
      const sessionId = String(started.sessionId ?? '');
      if (!sessionId) throw new Error(`${input.command} ACP did not return a session id`);
      live.sessionId = sessionId;
      turn.sessionId = sessionId;
      await input.onSessionId?.(sessionId);
      stillRunning();
    }
    this.sessionId = turn.sessionId;
    const blocks: Json[] = [{ type: 'text', text: input.prompt }, ...await Promise.all(images.map(acpImageBlock))];
    stillRunning();
    turn.promptStarted = true;
    turn.prompt = peer.request('session/prompt', { sessionId: turn.sessionId, prompt: blocks });
    const completed = await turn.prompt as Json;
    if (completed.stopReason === 'cancelled') throw cancelledError();
    const usage = completed.usage ?? completed._meta?.usage;
    if (usage && typeof usage === 'object') input.onUsage?.(usage as Record<string, unknown>);
    const text = turn.text.trim();
    // Tool-only turns are real work with nothing to say. Only a turn that
    // produced neither prose nor activity is a failure.
    if (!text && !turn.sawActivity) throw new Error(`${input.command} ACP returned no assistant text`);
    return { text, nativeSessionId: turn.sessionId! };
  }

  private update(params: Json): void {
    const turn = this.turn;
    if (!turn || turn.done) return;
    const update: Json = params.update ?? {};
    if (typeof params.sessionId === 'string' && turn.sessionId && params.sessionId !== turn.sessionId) return;
    const { input } = turn;
    // Command palettes are session state, not history, and usually arrive
    // right after session/new -- before the prompt.
    const commands = acpAvailableCommands(update);
    if (commands) return input.onAvailableCommands?.(commands);
    // session/load replays the old conversation as ordinary updates. Nothing
    // before our own prompt belongs to this turn.
    if (!turn.promptStarted) return;
    const delta = acpResponseDelta(update);
    if (delta) { turn.text += delta; input.onResponseDelta?.(delta); return; }
    const thought = acpThoughtDelta(update);
    if (thought) return input.onThought?.(thought);
    const activity = acpActivityEvent(update);
    if (activity) { turn.sawActivity = true; input.onActivity?.(activity); return; }
    const plan = acpPlanEntries(update);
    if (plan) return input.onPlan?.(plan);
    if (update.sessionUpdate === 'usage_update' || (update.usage && typeof update.usage === 'object')) {
      input.onUsage?.((update.usage && typeof update.usage === 'object' ? update.usage : update) as Record<string, unknown>);
    }
  }

  private async permission(params: Json): Promise<Json> {
    const turn = this.turn;
    const cancelled = { outcome: { outcome: 'cancelled' } };
    if (!turn || turn.done) return cancelled;
    const plan = acpPermissionPlan(turn.input.permissionMode, params);
    let accepted = plan.action === 'allow';
    if (!accepted) {
      const title = String(params.toolCall?.title ?? params.toolCall?.name ?? 'Approve tool');
      const detail = [
        acpApprovalDetail(params.toolCall),
        plan.allowIsPersistent ? 'Approving grants this permanently: the agent offers no one-time option.' : undefined,
      ].filter(Boolean).join('\n') || undefined;
      accepted = plan.allowOptionId !== undefined && await turn.input.onApproval?.(title, detail) === true;
    }
    // ACP requires `cancelled` for requests outstanding when a turn is cancelled.
    if (turn.done) return cancelled;
    const optionId = accepted ? plan.allowOptionId : plan.rejectOptionId;
    return optionId !== undefined ? { outcome: { outcome: 'selected', optionId } } : cancelled;
  }
}

/** One agent process kept alive across turns: initialize once, open or resume
 * the session once, then one session/prompt per turn. If the child dies (or
 * its launch arguments change) the next turn respawns and resumes. */
export function createAcpSession(options: AcpSessionOptions = {}): AcpSession {
  return new AcpSessionImpl(options);
}

export async function runAcpTurn(input: AcpTurnInput, options: AcpSessionOptions = {}): Promise<AcpTurnResult> {
  if (!acpSpawnArgv(input)) throw new Error(`${input.command} has no ACP adapter`);
  const session = createAcpSession(options);
  try {
    return await session.runTurn(input);
  } finally {
    // Shutdown is graceful (up to seconds); the caller already has its answer.
    void session.close().catch(() => undefined);
  }
}

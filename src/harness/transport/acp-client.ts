/** Shared Agent Client Protocol transport. Providers that publish ACP can use
 * this one lifecycle/stream/approval implementation instead of accumulating
 * another vendor-shaped JSON parser. The existing CLI adapter remains the
 * compatibility fallback for products without ACP. */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { AiHarnessPermissionMode } from '../definition.js';
import type { HarnessActivityEvent, ToolCategory } from '../prompter.js';
import type { HarnessAvailableCommand, HarnessPlanEntry, HarnessTurnObserver } from '../events/turn-observer.js';
import { eventDiff } from '../../agent/line-diff.js';
import { commandOutcome } from '../protocol/activity-events.js';
import { categoryOf, formatToolRow, isAgentToolName, toolLabel } from '../protocol/tools.js';
import { acpSessionTotals, normalizeTurnUsage, turnShareOf, turnStopReason, type TurnUsage } from '../protocol/turn-usage.js';
import { spawnPortable } from './spawn.js';
import { JSONRPC_SETUP_TIMEOUT_MS, JsonRpcPeer } from './jsonrpc-peer.js';
import { BackgroundTurnChannel, type BackgroundTurnEnd, type VendorBackgroundTurnHandler } from './background-turn.js';
import { createTurnWatchdog, turnIdleError, type TurnWatchdog } from './turn-watchdog.js';

type Json = Record<string, any>;

/** Tool kinds that cannot change the workspace or run code. `auto` approves
 * only these; everything else still reaches the user. */
const READ_LIKE_TOOL_KINDS: ReadonlySet<string> = new Set(['read', 'search', 'think', 'fetch']);
const DIFF_LINE_CAP = 200;
const OUTPUT_LINE_CAP = 20;
const DETAIL_LINE_CAP = 12;
const CANCEL_SETTLE_MS = 2000;
/** How long an agent that said it is retrying a rate-limited call gets to
 * make progress before the turn is given up as throttled. Vibe backs off for
 * minutes after one `_session/retrying`, with nothing on the wire meanwhile;
 * handing the turn to the next account beats waiting that out. */
export const ACP_RATE_LIMIT_GRACE_MS = 30_000;

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
  /** Require model/effort selection over ACP when CLI launch flags are not
   * valid for this agent's ACP entry point. */
  modelRequiresProtocol?: boolean;
  effortRequiresProtocol?: boolean;
  effortConfigId?: string;
  permissionModeIds?: Readonly<Partial<Record<AiHarnessPermissionMode, string>>>;
  /** Local image paths, sent as ACP image blocks when the agent advertises
   * `promptCapabilities.image`. Otherwise the turn fails before the prompt
   * with `acpUnsupportedImages` so the caller can use its image-capable CLI. */
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
  /** The catalog's `acp.usageTotals`: the prompt response's usage is the
   * session's running total, not the turn's. */
  usageTotals?: 'session';
  /** Setup request timeout (initialize, session/new|resume|load). */
  setupTimeoutMs?: number;
  /** Override ACP_RATE_LIMIT_GRACE_MS. */
  rateLimitGraceMs?: number;
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

interface AcpSessionOptions {
  spawn?: AcpSpawn;
  /** Receives work the agent does between ClikCode turns. */
  backgroundTurns?: VendorBackgroundTurnHandler;
  /** Watchdog budgets (see turn-watchdog.ts); tests shorten them. */
  idleMs?: number;
  toolIdleMs?: number;
}

export function acpResponseDelta(update: Json): string | undefined {
  return update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string'
    ? update.content.text : undefined;
}

export function acpVibeResponseChange(previous: string, incoming: string): { text: string; mode: 'append' | 'replace'; current: string } {
  if (!previous) return { text: incoming, mode: 'append', current: incoming };
  if (incoming.startsWith(previous)) {
    const text = incoming.slice(previous.length);
    return { text, mode: 'append', current: incoming };
  }
  let sharedPrefix = 0;
  while (sharedPrefix < previous.length && sharedPrefix < incoming.length && previous[sharedPrefix] === incoming[sharedPrefix]) sharedPrefix++;
  if (sharedPrefix > 0) return { text: incoming, mode: 'replace', current: incoming };
  return { text: incoming, mode: 'append', current: previous + incoming };
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
  // The changed lines, through the same line diff ClikCode's own agent
  // uses -- not both texts whole.
  const diff = diffEntry ? eventDiff(String(diffEntry.oldText ?? ''), String(diffEntry.newText ?? ''), DIFF_LINE_CAP) : undefined;
  const outputText = content
    .flatMap((entry) => entry?.type === 'content' && entry.content?.type === 'text' && typeof entry.content.text === 'string' ? [entry.content.text as string] : [])
    .join('\n');
  const output = outputText.trim() ? outputText.replace(/\r?\n$/, '').split(/\r?\n/).slice(-OUTPUT_LINE_CAP) : undefined;
  const classified = acpToolClass(update);
  const rawOutput = update.rawOutput && typeof update.rawOutput === 'object' ? update.rawOutput as Record<string, unknown> : undefined;
  return {
    kind: status === 'failed' ? 'tool-error' : completed ? 'tool-done' : 'tool-start',
    label: acpToolLabel(update, classified),
    ...classified,
    ...(typeof update.toolCallId === 'string' ? { id: update.toolCallId } : {}),
    ...(output ? { output } : {}),
    ...(diff ? { diff } : {}),
    ...(completed ? commandOutcome(rawOutput) : {}),
  };
}

/** The row an ACP call gets. Its title is the agent's own sentence ("Read
 * config", "`npm test`"), so where the input or the locations name the
 * target the row is built from those, the same as every other harness's;
 * the title is kept only when nothing better is known. */
function acpToolLabel(update: Json, classified: { category?: ToolCategory; agent?: true }): string {
  const raw = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput as Record<string, unknown> : undefined;
  const title = typeof (update.title ?? update.name) === 'string' ? String(update.title ?? update.name).trim() : '';
  if (classified.agent) return formatToolRow('agent', typeof raw?.description === 'string' ? raw.description : title);
  const head = title.split(/[\s:(]/, 1)[0] || 'tool';
  const fromInput = raw ? toolLabel(classified.category === 'run' ? 'shell' : head, raw, classified.category) : undefined;
  if (fromInput && fromInput !== formatToolRow(classified.category === 'run' ? 'shell' : head, undefined, classified.category)) return fromInput;
  const location = Array.isArray(update.locations) ? update.locations.find((entry: Json) => typeof entry?.path === 'string')?.path as string | undefined : undefined;
  if (location && classified.category && classified.category !== 'run') return formatToolRow(head, location, classified.category);
  return title || 'tool';
}

/** ACP publishes a tool kind (`execute`, `read`, …) and, when the agent
 * sends it, the raw input. Titles are a sentence ("Read config"), so only
 * the first word is a tool name. Anything that matches neither stays
 * unclassified. */
const ACP_KIND_CATEGORY: Readonly<Record<string, ToolCategory>> = {
  execute: 'run', read: 'read', edit: 'edit', delete: 'edit', move: 'edit', search: 'search', fetch: 'fetch',
};

function acpToolClass(update: Json): { category?: ToolCategory; agent?: true } {
  const raw = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput as Record<string, unknown> : undefined;
  const titled = String(update.name ?? update.title ?? '');
  const head = titled.split(/[\s:(]/, 1)[0] || titled;
  const fromKind = ACP_KIND_CATEGORY[String(update.kind ?? '').toLowerCase()];
  const command = Array.isArray(raw?.command) ? raw.command.map(String).join(' ')
    : typeof raw?.command === 'string' ? raw.command
      : typeof raw?.cmd === 'string' ? raw.cmd : '';
  const category = fromKind ?? (command.trim() ? 'run' as const : categoryOf(head, raw).category);
  const agent = isAgentToolName(head) || isAgentToolName(String(update.tool ?? '')) ? true as const : undefined;
  return { ...(category ? { category } : {}), ...(agent ? { agent } : {}) };
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

/** The agent's own id for a chosen model. Hermes names models
 * `provider:model`; a bare model still resolves when exactly one provider
 * offers it. Undefined when the agent publishes no list, or the choice is not
 * on it and not a `provider:model` id the agent can parse -- the launch flags
 * then stand as the only selector. */
export function acpModelChoice(models: Json | undefined, model: string): string | undefined {
  const available: unknown[] = Array.isArray(models?.availableModels) ? models!.availableModels : [];
  const ids = available.map((entry) => (entry as Json | null)?.modelId).filter((id): id is string => typeof id === 'string');
  if (ids.length === 0 && Array.isArray(models?.configOptions)) {
    const modelOption = models.configOptions.find((option: Json) => (option?.id ?? option?.configId) === 'model');
    if (Array.isArray(modelOption?.options)) {
      for (const option of modelOption.options) if (typeof option?.value === 'string') ids.push(option.value);
    }
  }
  if (ids.includes(model)) return model;
  const suffixed = ids.filter((id) => id.endsWith(`:${model}`));
  if (suffixed.length === 1) return suffixed[0];
  // An agent whose ids are `provider:model` parses any such id, including a
  // provider its list leaves out -- Hermes lists only providers configured in
  // its config, but also runs ones it found signed in elsewhere (Claude
  // Code's sign-in, a `gh` token). The provider half is sent as chosen.
  const providerShaped = /^[a-z][a-z0-9_-]*:[^:]/i;
  return ids.length && ids.every((id) => providerShaped.test(id)) && providerShaped.test(model) ? model : undefined;
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
  /** The loaded session's model state (`currentModelId`, `availableModels`). */
  models?: Json;
  modes?: Json;
  configOptions?: Json[];
}

/** Whatever is receiving the agent's session/update right now: the user's
 * turn, or a background turn when there is none. */
interface Stream {
  observer: HarnessTurnObserver;
  command: string;
  text: string;
  vibeMessageText: string;
  sawActivity: boolean;
  /** The thought streaming now: ACP sends fragments with no id, so a thought
   * is a run of `agent_thought_chunk`s that anything else ends. */
  thought?: { id: string; text: string };
  thoughts: number;
  /** The session's running totals when this turn's prompt was sent: agents
   * report the session's cost (and some its tokens) so far, and a turn's
   * share is what they grew by. */
  base: TurnUsage;
  watchdog?: TurnWatchdog;
}

interface ActiveTurn extends Stream {
  input: AcpTurnInput;
  promptStarted: boolean;
  done: boolean;
  sessionId?: string;
  prompt?: Promise<unknown>;
  fail: (error: Error) => void;
  /** Running while the agent retries a rate-limited call; progress stops it. */
  throttled?: NodeJS.Timeout;
}

interface BackgroundRun extends Stream {
  channel: BackgroundTurnChannel;
}

/** Updates that carry the agent's work and so can open a background turn.
 * Session bookkeeping (usage, titles, modes, command palettes) never does. */
const CONTENT_UPDATES: ReadonlySet<string> = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);
/** What agents publish as a prompt winds up (cline and hermes send
 * `session_info_update`, kimi and hermes `usage_update`). ACP has no
 * turn-completed notification outside session/prompt, so for a background
 * turn with no tool left running this is the end marker. */
const TURN_BOOKKEEPING_UPDATES: ReadonlySet<string> = new Set(['usage_update', 'session_info_update']);

const toolRunning = (update: Json): boolean => update.status === 'pending' || update.status === 'in_progress' || update.status === undefined;
const toolSettled = (update: Json): boolean => update.status === 'completed' || update.status === 'failed';

class AcpSessionImpl implements AcpSession {
  private live?: LiveAgent;
  private turn?: ActiveTurn;
  private background?: BackgroundRun;
  /** Tool calls the agent started and has not settled, within the turn or
   * background turn that is receiving updates. */
  private readonly pendingTools = new Map<string, string>();
  private settling?: Promise<void>;
  private sessionId?: string;
  private lastCommand = 'agent';
  /** The live session's running totals as the agent last reported them
   * (acpSessionTotals, and a prompt response for an agent declaring
   * `usageTotals: 'session'`). Reset when a session is opened in this
   * process: an agent that restores its totals on load says so before the
   * prompt, and one that does not (Hermes) starts again from zero. */
  private sessionTotals: TurnUsage = {};
  private isClosed = false;
  private readonly spawn: AcpSpawn;
  private readonly onBackgroundTurn?: VendorBackgroundTurnHandler;
  private readonly idleMs?: number;
  private readonly toolIdleMs?: number;

  constructor(options: AcpSessionOptions) {
    this.spawn = options.spawn ?? ((binary, argv, spawnOptions) => spawnPortable(binary, [...argv], spawnOptions));
    this.onBackgroundTurn = options.backgroundTurns;
    this.idleMs = options.idleMs;
    this.toolIdleMs = options.toolIdleMs;
  }

  async runTurn(input: AcpTurnInput): Promise<AcpTurnResult> {
    if (this.isClosed) throw new Error(`${input.command} ACP session is closed`);
    if (this.turn) throw new Error(`${input.command} ACP session already has an active turn`);
    const argv = acpSpawnArgv(input);
    if (!argv) throw new Error(`${input.command} has no ACP adapter`);
    // From here on the user's turn receives what the agent says.
    this.finishBackground('superseded');
    this.lastCommand = input.command;
    let fail!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    failure.catch(() => undefined);
    const turn: ActiveTurn = {
      input, observer: input, command: input.command, text: '', vibeMessageText: '', sawActivity: false, thoughts: 0, base: {}, promptStarted: false, done: false, fail,
    };
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
      // After a failure the child's protocol state is unknown. Drop it; the
      // next turn respawns and resumes. Cancellation settles on its own path.
      if (!isCancelled(failureError)) this.dropLive(failureError);
      throw failureError;
    } finally {
      turn.done = true;
      turn.watchdog?.stop();
      if (turn.throttled) clearTimeout(turn.throttled);
      input.signal?.removeEventListener('abort', onAbort);
      if (this.turn === turn) this.turn = undefined;
      this.live?.peer.rejectPending(new Error(`${input.command} ACP turn ended`), (method) => method !== 'session/prompt');
      // ACP defines the answer to session/prompt as the end of the turn: a
      // tool call it left unsettled is not waited for (agents do leave some,
      // and waiting would hold a background turn open for the whole ceiling).
      // Anything the agent reports about it later opens a background turn.
      this.pendingTools.clear();
    }
  }

  cancel(): void {
    if (this.turn) this.cancelTurn(this.turn);
  }

  async close(): Promise<void> {
    this.isClosed = true;
    if (this.turn) this.cancelTurn(this.turn);
    this.finishBackground('closed');
    this.pendingTools.clear();
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
    this.finishBackground('closed');
    this.pendingTools.clear();
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
   * agent's out-of-turn updates are not surfaced, exactly as before. */
  private openBackground(): BackgroundRun | undefined {
    if (!this.onBackgroundTurn || this.isClosed) return undefined;
    if (this.background && !this.background.channel.done) return this.background;
    const channel = new BackgroundTurnChannel('acp', 'vendor-turn');
    const run: BackgroundRun = { channel, observer: channel.observer, command: this.lastCommand, text: '', vibeMessageText: '', sawActivity: false, thoughts: 0, base: { ...this.sessionTotals } };
    run.watchdog = this.watchdog(() => {
      if (this.background !== run) return;
      this.pendingTools.clear();
      this.finishBackground('idle-timeout');
    });
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
        onNotification: (method, params) => {
          if (method === 'session/update') this.update(params);
          else if (method === '_session/retrying') this.retrying(params);
        },
        onClose: (error) => {
          if (this.live === live) {
            this.live = undefined;
            this.finishBackground('closed');
            this.pendingTools.clear();
          }
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
      throw Object.assign(new Error(`${input.command} ACP does not accept image prompts`), { acpUnsupportedImages: true });
    }
    let loaded: Json | undefined;
    const wanted = input.nativeSessionId ?? this.sessionId;
    const created = input.nativeSessionId ? input.sessionCreated !== false : wanted !== undefined;
    if (wanted && created) {
      if (live.sessionId !== wanted) {
        // session/load streams the whole history before it answers, so its
        // timeout is an idle window rather than a wall-clock limit.
        const loading = { ...setup, idleReset: true };
        this.sessionTotals = {};
        if (capabilities.sessionCapabilities?.resume) loaded = await peer.request('session/resume', { sessionId: wanted, cwd: input.cwd, mcpServers: [] }, loading);
        else if (capabilities.loadSession) loaded = await peer.request('session/load', { sessionId: wanted, cwd: input.cwd, mcpServers: [] }, loading);
        else throw new Error(`${input.command} ACP cannot load sessions`);
        stillRunning();
        live.sessionId = wanted;
        live.models = loaded?.models ?? { configOptions: loaded?.configOptions };
        live.modes = loaded?.modes;
        live.configOptions = loaded?.configOptions;
      }
      turn.sessionId = wanted;
    } else {
      this.sessionTotals = {};
      const started = await peer.request('session/new', { cwd: input.cwd, mcpServers: [] }, setup);
      stillRunning();
      const sessionId = String(started.sessionId ?? '');
      if (!sessionId) throw new Error(`${input.command} ACP did not return a session id`);
      live.sessionId = sessionId;
      live.models = started.models ?? { configOptions: started.configOptions };
      live.modes = started.modes;
      live.configOptions = started.configOptions;
      turn.sessionId = sessionId;
    }
    // Agents that publish a model list take the choice over the protocol; a
    // launch flag is not guaranteed to reach the session (`hermes acp` ignores
    // `--model`, and would silently run its configured default).
    const modelId = input.model ? acpModelChoice(live.models, input.model) : undefined;
    if (input.model && !modelId && input.modelRequiresProtocol) {
      throw Object.assign(new Error(`${input.command} ACP does not list model ${input.model}`), { acpUnsupportedModel: true });
    }
    const modelConfig = live.configOptions?.find((option) => (option.id ?? option.configId) === 'model');
    const currentModel = live.models?.currentModelId ?? modelConfig?.currentValue;
    if (modelId && modelId !== currentModel) {
      if (modelConfig) await peer.request('session/set_config_option', { sessionId: turn.sessionId, configId: 'model', value: modelId }, setup);
      else await peer.request('session/set_model', { sessionId: turn.sessionId, modelId }, setup);
      stillRunning();
      if (modelConfig) live.configOptions = live.configOptions?.map((option) => option === modelConfig ? { ...option, currentValue: modelId } : option);
      else live.models = { ...live.models, currentModelId: modelId };
    }
    const modeId = input.permissionModeIds?.[input.permissionMode];
    if (modeId && live.modes?.currentModeId !== modeId) {
      const available: Json[] = Array.isArray(live.modes?.availableModes) ? live.modes.availableModes : [];
      if (!available.some((mode) => mode.id === modeId)) throw new Error(`${input.command} ACP does not offer permission mode ${modeId}`);
      await peer.request('session/set_mode', { sessionId: turn.sessionId, modeId }, setup);
      stillRunning();
      live.modes = { ...live.modes, currentModeId: modeId };
    }
    if (input.effort && input.effortConfigId) {
      const effortOption = live.configOptions?.find((option) => (option.id ?? option.configId) === input.effortConfigId);
      const choices: Json[] = Array.isArray(effortOption?.options) ? effortOption.options : [];
      if (effortOption && choices.some((option) => option.value === input.effort) && effortOption.currentValue !== input.effort) {
        await peer.request('session/set_config_option', { sessionId: turn.sessionId, configId: input.effortConfigId, value: input.effort }, setup);
        stillRunning();
        live.configOptions = live.configOptions?.map((option) => option === effortOption ? { ...option, currentValue: input.effort } : option);
      } else if ((!effortOption || !choices.some((option) => option.value === input.effort)) && input.effortRequiresProtocol) {
        throw Object.assign(new Error(`${input.command} ACP does not offer effort ${input.effort}`), { acpUnsupportedEffort: true });
      }
    } else if (input.effort && input.effortRequiresProtocol) {
      throw Object.assign(new Error(`${input.command} ACP does not offer effort control`), { acpUnsupportedEffort: true });
    }
    this.sessionId = turn.sessionId;
    if (!wanted || !created) await input.onSessionId?.(turn.sessionId);
    stillRunning();
    const blocks: Json[] = [{ type: 'text', text: input.prompt }, ...await Promise.all(images.map(acpImageBlock))];
    stillRunning();
    // Taken now, not when the turn was created: a session/load above may have
    // reported the totals this turn is measured from.
    turn.base = { ...this.sessionTotals };
    turn.promptStarted = true;
    // The turn ends with the agent's answer to session/prompt. This is only
    // the ceiling for an agent that has stopped talking without answering.
    turn.watchdog = this.watchdog((afterMs) => turn.fail(turnIdleError(input.command, afterMs)));
    turn.prompt = peer.request('session/prompt', { sessionId: turn.sessionId, prompt: blocks });
    const completed = await turn.prompt as Json;
    if (completed.stopReason === 'cancelled') throw cancelledError();
    // `end_turn`, or the reason the agent stopped short (max_tokens,
    // max_turn_requests, refusal), beside whatever usage it counted.
    // Gemini's ACP answers with `_meta.quota.token_count` {input_tokens,
    // output_tokens}, the turn's, beside the standard field.
    let usage = normalizeTurnUsage(completed.usage ?? completed._meta?.usage ?? completed._meta?.quota?.token_count);
    if (usage && input.usageTotals === 'session') {
      this.sessionTotals = { ...this.sessionTotals, ...turnShareOf(usage, {}) };
      usage = { ...usage, ...turnShareOf(usage, turn.base) };
    }
    const stopReason = turnStopReason(completed.stopReason);
    if (usage || stopReason) input.onUsage?.({ ...usage, ...(stopReason ? { stopReason } : {}) });
    const text = turn.text.trim();
    // Tool-only turns are real work with nothing to say. Only a turn that
    // produced neither prose nor activity is a failure.
    if (!text && !turn.sawActivity) throw new Error(`${input.command} ACP returned no assistant text`);
    return { text, nativeSessionId: turn.sessionId! };
  }

  /** Where an update goes: the user's turn while one runs, otherwise a
   * background turn, opened by an update that carries work. */
  private targetFor(update: Json): Stream | undefined {
    if (this.turn) return this.turn.done ? undefined : this.turn;
    if (this.background && !this.background.channel.done) return this.background;
    return CONTENT_UPDATES.has(String(update.sessionUpdate)) ? this.openBackground() : undefined;
  }

  private update(params: Json): void {
    const update: Json = params.update ?? {};
    const turn = this.turn && !this.turn.done ? this.turn : undefined;
    const expected = turn?.sessionId ?? this.sessionId;
    if (typeof params.sessionId === 'string' && expected && params.sessionId !== expected) return;
    // Running totals are the session's, whoever is listening: taken during a
    // session/load replay (the baseline) and after a prompt was answered.
    const totals = acpSessionTotals(update);
    if (totals) this.sessionTotals = { ...this.sessionTotals, ...totals };
    // session/load replays the old conversation as ordinary updates. Nothing
    // before our own prompt belongs to this turn -- but command palettes are
    // session state, and usually arrive right after session/new.
    if (turn && !turn.promptStarted) {
      const commands = acpAvailableCommands(update);
      if (commands) turn.input.onAvailableCommands?.(commands);
      return;
    }
    const target = this.targetFor(update);
    target?.watchdog?.activity();
    this.trackTool(target, update);
    if (target) this.deliver(target, update, totals);
    const run = this.background;
    if (run && target === run && this.pendingTools.size === 0) {
      // Event-driven end of a background turn: the last tool it was waiting
      // for settled, or (no tool involved) the agent's own end-of-turn
      // bookkeeping arrived.
      const settledLastTool = update.sessionUpdate === 'tool_call_update' && toolSettled(update);
      if (settledLastTool || TURN_BOOKKEEPING_UPDATES.has(String(update.sessionUpdate))) this.finishBackground('completed');
    }
  }

  private trackTool(target: Stream | undefined, update: Json): void {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    if (!id) return;
    if (toolSettled(update)) {
      this.pendingTools.delete(id);
      target?.watchdog?.toolFinished(id);
    } else if (update.sessionUpdate === 'tool_call' ? toolRunning(update) : update.status === 'in_progress' || update.status === 'pending') {
      if (!this.pendingTools.has(id)) this.pendingTools.set(id, String(update.title ?? 'tool'));
      target?.watchdog?.toolStarted(id);
    }
  }

  private deliver(target: Stream, update: Json, totals?: TurnUsage): void {
    const input = target.observer;
    // Session totals (usage_update's cost; Vibe's and OpenHands' `_meta`
    // tokens, which OpenHands puts on its message and tool updates) count
    // for this turn by what they grew since it began.
    const share = totals ? turnShareOf(this.sessionTotals, target.base) : undefined;
    if (share && update.sessionUpdate !== 'usage_update') input.onUsage?.(share);
    const commands = acpAvailableCommands(update);
    if (commands) return input.onAvailableCommands?.(commands);
    const turn = target === this.turn ? this.turn : undefined;
    if (turn?.throttled && update.sessionUpdate !== 'usage_update' && update.sessionUpdate !== 'user_message_chunk') {
      clearTimeout(turn.throttled);
      turn.throttled = undefined;
    }
    const thought = acpThoughtDelta(update);
    // Anything but a thought (or a usage reading) ends the thought in progress.
    if (!thought && update.sessionUpdate !== 'usage_update') target.thought = undefined;
    const delta = acpResponseDelta(update);
    if (delta) {
      if (target.command === 'vibe' && typeof update.messageId === 'string') {
        const change = acpVibeResponseChange(target.vibeMessageText, delta);
        target.vibeMessageText = change.current;
        if (change.mode === 'replace') target.text = change.current;
        else target.text += change.text;
        input.onResponseDelta?.(change.text, change.mode);
      } else {
        target.text += delta;
        input.onResponseDelta?.(delta);
      }
      return;
    }
    if (thought) {
      target.thought ??= { id: `thought-${++target.thoughts}`, text: '' };
      target.thought.text += thought;
      return input.onThought?.(target.thought.text, target.thought.id);
    }
    const activity = acpActivityEvent(update);
    if (activity) { target.sawActivity = true; input.onActivity?.(activity); return; }
    const plan = acpPlanEntries(update);
    if (plan) return input.onPlan?.(plan);
    // `usage_update` {used, size, cost}: the context the session occupies,
    // its window, and what it has cost -- live, while the turn runs.
    if (update.sessionUpdate === 'usage_update' || (update.usage && typeof update.usage === 'object')) {
      const usage = normalizeTurnUsage(update.usage && typeof update.usage === 'object' ? update.usage : update) ?? {};
      // Its cost is the session's; the turn's is its share.
      if (update.sessionUpdate === 'usage_update') delete usage.costUsd;
      Object.assign(usage, share);
      if (Object.keys(usage).length) input.onUsage?.(usage);
    }
  }

  /** The agent's own notice that it is retrying a failed model call
   * (`_session/retrying`, Vibe: `{category:"rate_limited", detail:"HTTP 429"}`).
   * A rate limit is shown, and if nothing else arrives within the grace the
   * turn fails as a 429 -- which failover reads as throttled and moves on. */
  private retrying(params: Json): void {
    const turn = this.turn;
    if (!turn || turn.done || !turn.promptStarted) return;
    if (typeof params.sessionId === 'string' && turn.sessionId && params.sessionId !== turn.sessionId) return;
    turn.watchdog?.activity();
    const category = typeof params.category === 'string' ? params.category : '';
    const detail = typeof params.detail === 'string' ? params.detail : '';
    turn.input.onPhase?.(`${turn.input.command} is retrying${detail ? ` (${detail})` : ''}`);
    if (!/rate|limit|quota|throttl/i.test(category) || turn.throttled) return;
    const status = Number(/\b(4\d\d|5\d\d)\b/.exec(detail)?.[1] ?? 429);
    const grace = turn.input.rateLimitGraceMs ?? ACP_RATE_LIMIT_GRACE_MS;
    turn.throttled = setTimeout(() => {
      turn.throttled = undefined;
      if (turn.done) return;
      turn.fail(Object.assign(
        new Error(`${turn.input.command}: rate limited${detail ? ` (${detail})` : ''}, still retrying after ${Math.round(grace / 1000)}s`),
        { statusCode: status },
      ));
    }, grace);
    turn.throttled.unref?.();
  }

  private async permission(params: Json): Promise<Json> {
    const turn = this.turn && !this.turn.done ? this.turn : undefined;
    const cancelled = { outcome: { outcome: 'cancelled' } };
    // Out of turn the agent still asks -- through the background turn.
    const stream: Stream | undefined = turn ?? (this.turn ? undefined : this.background ?? this.openBackground());
    if (!stream) return cancelled;
    const plan = acpPermissionPlan(turn?.input.permissionMode ?? 'ask', params);
    let accepted = plan.action === 'allow';
    if (!accepted) {
      const title = String(params.toolCall?.title ?? params.toolCall?.name ?? 'Approve tool');
      const detail = [
        acpApprovalDetail(params.toolCall),
        plan.allowIsPersistent ? 'Approving grants this permanently: the agent offers no one-time option.' : undefined,
      ].filter(Boolean).join('\n') || undefined;
      // The agent is waiting on the user, not wedged.
      const resume = stream.watchdog?.pause();
      try {
        accepted = plan.allowOptionId !== undefined && await stream.observer.onApproval?.(title, detail) === true;
      } finally {
        resume?.();
      }
    }
    // ACP requires `cancelled` for requests outstanding when a turn is cancelled.
    if (turn?.done) return cancelled;
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

/** Shared Agent Client Protocol transport. Providers that publish ACP can use
 * this one lifecycle/stream/approval implementation instead of accumulating
 * another vendor-shaped JSON parser. The existing CLI adapter remains the
 * compatibility fallback for products without ACP. */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AiHarnessAcpDefinition, AiHarnessPermissionMode } from '../definition.js';
import type { HarnessActivityEvent, ToolCategory } from '../prompter.js';
import type { HarnessAvailableCommand, HarnessPlanEntry, HarnessTurnObserver } from '../events/turn-observer.js';
import { eventDiff } from '../../agent/line-diff.js';
import { commandOutcome } from '../protocol/activity-events.js';
import { categoryOf, commandText, formatToolRow, isAgentToolName, toolLabel } from '../protocol/tools.js';
import { acpSessionTotals, normalizeTurnUsage, turnShareOf, turnStopReason, type TurnUsage } from '../protocol/turn-usage.js';
import { claudeRateLimitReading } from '../accounts/usage-reading.js';
import { activityOutput, editDiffFromInput, toolCall } from '../protocol/activity-events.js';
import { turnCancelledError } from '../../agent/cancellation.js';
import { JSONRPC_SETUP_TIMEOUT_MS, type JsonRpcPeer } from './jsonrpc-peer.js';
import { BackgroundTurnChannel } from './background-turn.js';
import { configuredIdleMs, turnIdleError, type TurnWatchdog } from './turn-watchdog.js';
import { PersistentSession, runOneTurn, turnFailure, type PersistentSessionOptions } from './persistent-session.js';

type Json = Record<string, any>;

/** Tool kinds that cannot change the workspace or run code. `auto` approves
 * only these; everything else still reaches the user. */
const READ_LIKE_TOOL_KINDS: ReadonlySet<string> = new Set(['read', 'search', 'think', 'fetch']);
const DETAIL_LINE_CAP = 12;
/** How long an agent that said it is retrying a rate-limited call gets to
 * make progress before the turn is given up as throttled. Vibe backs off for
 * minutes after one `_session/retrying`, with nothing on the wire meanwhile;
 * handing the turn to the next account beats waiting that out. */
export const ACP_RATE_LIMIT_GRACE_MS = 30_000;
/** How long an agent may take to answer before the wait is named. */
const START_NOTICE_MS = 1_000;

/** What this client can show. `terminal_output`: a command's output and exit
 * code as `_meta.terminal_output` / `_meta.terminal_exit` (claude-agent-acp's
 * terminal extension, as codex-acp does) rather than a fenced text block with
 * no exit code. An agent that does not know the key ignores it. */
const ACP_CLIENT_CAPABILITIES = { _meta: { terminal_output: true } };

export interface AcpTurnInput extends HarnessTurnObserver {
  binary: string;
  command: string;
  cwd: string;
  prompt: string;
  nativeSessionId?: string;
  environment: Readonly<Record<string, string>>;
  permissionMode: AiHarnessPermissionMode;
  model?: string | null;
  effort?: string | null;
  /** The harness's catalog ACP entry: how model, effort and permission mode
   * are selected over the protocol, and what its usage readings mean. */
  acp?: Pick<AiHarnessAcpDefinition, 'inheritCliOptions' | 'effortConfigId' | 'providerConfigId' | 'permissionModeIds' | 'usageTotals' | 'cumulativeChunks'>;
  modelProviderSeparator?: string;
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
  /** The adapter handshake's timeout (initialize). Requests that wait on the
   *  agent starting up are bounded by the idle budget instead. */
  setupTimeoutMs?: number;
  /** Servers this session should start. Empty keeps the previous request. */
  mcpServers?: readonly Record<string, unknown>[];
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
  /** Work the vendor is still doing between turns (persistent-session.ts). */
  backgroundWorkRunning(): Promise<boolean>;
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

/** The tool call a sub-agent's update belongs to: claude-agent-acp's
 * `_meta.claudeCode.parentToolUseId` (stamped on the sub-agent's tool calls,
 * prose and thinking). */
export function acpParentToolId(update: Json): string | undefined {
  const parent = update?._meta?.claudeCode?.parentToolUseId;
  return typeof parent === 'string' && parent ? parent : undefined;
}

export function acpActivityEvent(update: Json): HarnessActivityEvent | undefined {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return undefined;
  const status = String(update.status);
  const completed = ['completed', 'failed'].includes(status);
  const content: Json[] = Array.isArray(update.content) ? update.content : [];
  const diffEntries = content.filter((entry) => entry?.type === 'diff');
  // Every file the call changed, each its own (a fragment's lines are not
  // numbered: ACP sends the replaced text, not the file). An agent that sends
  // no diff content still says what it is replacing in its input.
  // A missing oldText is "new file" in the protocol, but agents send it for
  // every write (claude-agent-acp's Write among them): unknown, not empty.
  const fromContent = diffEntries.flatMap((entry) => eventDiff(String(entry.oldText ?? ''), String(entry.newText ?? ''), {
    ...(typeof entry.path === 'string' && entry.path ? { path: entry.path } : {}),
    ...(typeof entry.oldText === 'string' ? {} : { priorUnknown: true }),
  }));
  const terminal = update._meta && typeof update._meta === 'object' ? update._meta as Json : undefined;
  // `terminal_output` is `{ terminal_id, data }` (claude-agent-acp 0.84).
  const terminalText = typeof terminal?.terminal_output?.data === 'string' ? terminal.terminal_output.data : undefined;
  const outputText = terminalText !== undefined ? terminalText : content
    .flatMap((entry) => entry?.type === 'content' && entry.content?.type === 'text' && typeof entry.content.text === 'string' ? [entry.content.text as string] : [])
    .join('\n');
  const exitCode = terminal?.terminal_exit?.exit_code;
  // The end of what the tool printed: a command's last lines are its result.
  const output = activityOutput(outputText, { tail: true });
  const classified = acpToolClass(update);
  const rawOutput = update.rawOutput && typeof update.rawOutput === 'object' ? update.rawOutput as Record<string, unknown> : undefined;
  const diff = fromContent.length ? fromContent
    : classified.category === 'edit' ? editDiffFromInput(update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : undefined) : undefined;
  return {
    kind: status === 'failed' ? 'tool-error' : completed ? 'tool-done' : 'tool-start',
    label: acpToolLabel(update, classified),
    ...classified,
    ...acpToolCall(update),
    ...(typeof update.toolCallId === 'string' ? { id: update.toolCallId } : {}),
    ...(acpParentToolId(update) ? { parentId: acpParentToolId(update)! } : {}),
    ...output,
    ...(diff?.length ? { diff } : {}),
    ...(completed ? commandOutcome(rawOutput) : {}),
    ...(typeof exitCode === 'number' ? { exitCode } : {}),
  };
}

/** The call as the agent described it: ACP has no tool name, only a title
 * ("Read config") whose first word stands in for one, and the raw input. */
function acpToolCall(update: Json): Pick<HarnessActivityEvent, 'call'> {
  const raw = update.rawInput && typeof update.rawInput === 'object' && !Array.isArray(update.rawInput) ? update.rawInput as Record<string, unknown> : undefined;
  if (!raw || !Object.keys(raw).length) return {};
  const title = typeof (update.title ?? update.name) === 'string' ? String(update.title ?? update.name).trim() : '';
  const name = (typeof update.name === 'string' && update.name.trim()) || title.split(/[\s:(]/, 1)[0] || String(update.kind ?? 'tool');
  return { call: toolCall(name, raw) };
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

/** The command a call runs: `command` (string or argv), else `cmd`. */
function acpCommand(raw: Record<string, unknown> | undefined): string | undefined {
  return commandText(raw?.command) ?? (typeof raw?.cmd === 'string' ? raw.cmd : undefined);
}

function acpToolClass(update: Json): { category?: ToolCategory; agent?: true } {
  const raw = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput as Record<string, unknown> : undefined;
  const titled = String(update.name ?? update.title ?? '');
  const head = titled.split(/[\s:(]/, 1)[0] || titled;
  const fromKind = ACP_KIND_CATEGORY[String(update.kind ?? '').toLowerCase()];
  const category = fromKind ?? (acpCommand(raw)?.trim() ? 'run' as const : categoryOf(head, raw).category);
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
  const command = acpCommand(raw);
  if (command) lines.push(`$ ${command}`);
  if (typeof raw.cwd === 'string') lines.push(`cwd: ${raw.cwd}`);
  const paths = new Set<string>();
  for (const key of ['path', 'file_path', 'filePath', 'abs_path', 'url']) if (typeof raw[key] === 'string') paths.add(raw[key]);
  if (Array.isArray(toolCall.locations)) for (const location of toolCall.locations) if (typeof location?.path === 'string') paths.add(location.path);
  const content: Json[] = Array.isArray(toolCall.content) ? toolCall.content : [];
  for (const entry of content) if (entry?.type === 'diff' && typeof entry.path === 'string') paths.add(entry.path);
  for (const path of paths) lines.push(path);
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
 * The argv comes from the catalog (`harnessAcpLaunch`), which derives the
 * mode, model, effort and permission flags from the harness's own entry; no
 * per-harness flag is known here, so none can drift from the catalog. */
export function acpSpawnArgv(
  input: Pick<AcpTurnInput, 'argv' | 'optionPlacement' | 'extraArgv'>,
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
  // Some agents expose decorated protocol ids while their CLI and picker
  // show the plain name (Cursor: `gpt-5.5[...]` versus `gpt-5.5`). Resolve
  // only an unambiguous advertised name; never guess between variants.
  const named = available.filter((entry) =>
    typeof (entry as Json | null)?.name === 'string' && (entry as Json).name.toLowerCase() === model.toLowerCase());
  if (named.length === 1 && typeof (named[0] as Json).modelId === 'string') return (named[0] as Json).modelId;
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
  /** The agent takes `_session/steering` (InitializeResponse
   * `_meta.steering.supported`; claude-agent-acp 0.84). */
  steering?: boolean;
}

/** A message typed during the turn, waiting for a moment it can be steered
 * in without interrupting anything (see AcpSessionImpl.steerSafe). */
interface HeldSteer {
  text: string;
  /** Settles when the broker has its fallback copy queued; never sent first. */
  ready: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Whatever is receiving the agent's session/update right now: the user's
 * turn, or a background turn when there is none. */
interface Stream {
  observer: HarnessTurnObserver;
  /** The catalog's `acp.cumulativeChunks`. */
  cumulativeChunks: boolean;
  text: string;
  /** The message so far, for an agent that sends cumulative chunks. */
  messageText: string;
  sawActivity: boolean;
  /** Text after a tool call is a new paragraph. ACP agents resume their
   * reply with no break of their own, and appended straight on ("first.The
   * final…") it rewrote the paragraph already drawn above the call -- the
   * screen showed the reply twice, then lost the last block at turn end.
   * The CLI parsers keep the same flag (events/adapters.ts). */
  needsSeparator?: boolean;
  /** Tool calls this stream has seen settle. An update that arrives after
   * (Claude's final diff, sent by its PostToolUse hook once the result is in)
   * carries no status; read as a start it reopened a finished row and left a
   * running call no completion would ever close. */
  settledTools?: Set<string>;
  /** What each sub-agent is saying now, by its parent Agent call: one run
   * of prose or of thinking, begun again by its next call or a switch. */
  subagentText?: Map<string, { kind: string; text: string }>;
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
  /** Messages waiting to be steered in, oldest first. */
  held: HeldSteer[];
  /** The `_session/steering` requests being sent now, one at a time. */
  flushing?: Promise<void>;
  /** Approvals the user is being asked for now. */
  approvals: number;
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

class AcpSessionImpl extends PersistentSession<LiveAgent, ActiveTurn, BackgroundRun> implements AcpSession {
  /** Tool calls the agent started and has not settled, within the turn or
   * background turn that is receiving updates. */
  private readonly pendingTools = new Map<string, string>();
  private sessionId?: string;
  private lastCumulativeChunks = false;
  /** The live session's running totals as the agent last reported them
   * (acpSessionTotals, and a prompt response for an agent declaring
   * `usageTotals: 'session'`). Reset when a session is opened in this
   * process: an agent that restores its totals on load says so before the
   * prompt, and one that does not (Hermes) starts again from zero. */
  private sessionTotals: TurnUsage = {};

  constructor(options: PersistentSessionOptions) {
    super(options, 'ACP');
  }

  async runTurn(input: AcpTurnInput): Promise<AcpTurnResult> {
    this.assertIdle(`${input.command} ACP`);
    const argv = acpSpawnArgv(input);
    if (!argv) throw new Error(`${input.command} has no ACP adapter`);
    this.lastCumulativeChunks = input.acp?.cumulativeChunks === true;
    const { failure, fail } = turnFailure();
    const turn: ActiveTurn = {
      input, observer: input, cumulativeChunks: this.lastCumulativeChunks, text: '', messageText: '', sawActivity: false, thoughts: 0, base: {}, promptStarted: false, done: false, fail,
      held: [], approvals: 0,
    };
    return this.runActive(turn, input.signal, failure, () => this.flow(turn, argv), {
      // After a failure the child's protocol state is unknown. Drop it; the
      // next turn respawns and resumes. Cancellation settles on its own path.
      failed: (error) => this.dropLive(error),
      ended: () => {
        if (turn.throttled) clearTimeout(turn.throttled);
        input.onSteerReady?.(undefined);
        this.releaseSteers(turn);
        this.live?.peer.rejectPending(new Error(`${input.command} ACP turn ended`), (method) => method !== 'session/prompt');
        // ACP defines the answer to session/prompt as the end of the turn: a
        // tool call it left unsettled is not waited for (agents do leave some,
        // and waiting would hold a background turn open for the whole ceiling).
        // Anything the agent reports about it later opens a background turn.
        this.pendingTools.clear();
      },
    });
  }

  protected clearPending(): void {
    this.pendingTools.clear();
  }

  protected pendingCount(): number {
    // Cleared at each answer (see `ended` above): between turns only tools a
    // background turn is following count.
    return this.background ? this.pendingTools.size : 0;
  }

  protected interrupt(turn: ActiveTurn, live: LiveAgent): boolean {
    const prompt = turn.prompt;
    if (!prompt || !turn.sessionId) return false;
    // The agent answers the prompt with stopReason `cancelled` once it has
    // unwound. Give it two seconds so the session stays resumable.
    live.peer.notify('session/cancel', { sessionId: turn.sessionId });
    this.settleCancel(live, (settled) => void prompt.then(() => undefined, () => undefined).then(settled));
    return true;
  }

  /** Open a background turn for the agent's out-of-turn updates. */
  private openBackground(): BackgroundRun | undefined {
    return this.openBackgroundRun(() => {
      const channel = new BackgroundTurnChannel('acp', 'vendor-turn');
      return { channel, observer: channel.observer, cumulativeChunks: this.lastCumulativeChunks, text: '', messageText: '', sawActivity: false, thoughts: 0, base: { ...this.sessionTotals } };
    });
  }

  private ensureLive(input: AcpTurnInput, argv: readonly string[]): LiveAgent {
    // Model, effort and permission flags are launch arguments: a change means
    // a new child, which then resumes the same session.
    return this.liveFor(JSON.stringify([input.binary, argv, input.cwd, input.environment]), `${input.command} ACP restarted`, {
      binary: input.binary, argv, cwd: input.cwd, environment: input.environment,
      peer: {
        label: `${input.command} ACP`,
        onRequest: (method, params) => method === 'session/request_permission' ? this.permission(params) : undefined,
        onNotification: (method, params) => {
          if (method === 'session/update') this.update(params);
          else if (method === '_session/retrying') this.retrying(params);
          else if (method === '_kiro.dev/metadata') this.kiroMetadata(params);
        },
      },
    }, {});
  }

  private async flow(turn: ActiveTurn, argv: readonly string[]): Promise<AcpTurnResult> {
    const { input } = turn;
    const live = this.ensureLive(input, argv);
    const { peer } = live;
    const setup = { timeoutMs: input.setupTimeoutMs ?? JSONRPC_SETUP_TIMEOUT_MS };
    // Past the handshake, a request waits on the agent's backend, which is
    // still starting: Claude Code connects every MCP server before it takes a
    // control request, and its adapter answers set_config_option only once
    // Claude Code has. That can take far longer than a handshake, and is not a
    // fault. Bounded like a silent turn instead; Esc still cancels it.
    const control = { timeoutMs: configuredIdleMs() };
    // Said once, only for an agent this turn started (one already running
    // answers at once), and only when it is slow to: not a flash every turn.
    let announced = Boolean(live.capabilities);
    const waitOnStart = async <T>(pending: Promise<T>): Promise<T> => {
      if (announced) return pending;
      const notice = setTimeout(() => { announced = true; input.onPhase?.(`waiting for ${input.command} to start`); }, START_NOTICE_MS);
      notice.unref?.();
      try { return await pending; } finally { clearTimeout(notice); }
    };
    const startingRequest = (method: string, params: Json): Promise<Json> => waitOnStart(peer.request(method, params, control));
    const stillRunning = (): void => { if (turn.done) throw turnCancelledError(); };
    const { effortConfigId, providerConfigId, permissionModeIds, usageTotals } = input.acp ?? {};
    // CLI launch flags are not valid for this agent's ACP entry point: model
    // and effort can only be selected over the protocol.
    const modelRequiresProtocol = input.acp?.inheritCliOptions === false;
    // "medium" is ClikCode's generic initial value. Agents without an ACP
    // effort control should use their own default instead of sending every
    // ordinary turn through the CLI fallback.
    const effortRequiresProtocol = modelRequiresProtocol && input.effort !== 'medium';
    if (!live.capabilities) {
      const initialized = await peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: ACP_CLIENT_CAPABILITIES,
        clientInfo: { name: 'clikcode', title: 'ClikCode', version: '1' },
      }, setup);
      live.capabilities = (initialized.agentCapabilities as Json | undefined) ?? {};
      live.steering = initialized._meta?.steering?.supported === true;
      stillRunning();
    }
    // A vendor that says it is signed out is not signed in over ACP
    // (`authenticate`): its own browser login showed no link on ClikCode's
    // screen and, from a phone, waited for ever (Devin, 2026-10-06). The error
    // reaches the turn, which signs in on ClikCode's screen like any other.
    const call = (method: string, params: Json, options: { timeoutMs?: number; idleReset?: boolean } = setup): Promise<Json> =>
      peer.request(method, params, options);
    const capabilities = live.capabilities;
    const mcpServers = input.mcpServers ?? [];
    const images = input.images ?? [];
    if (images.length && capabilities.promptCapabilities?.image !== true) {
      throw Object.assign(new Error(`${input.command} ACP does not accept image prompts`), { acpUnsupportedImages: true });
    }
    let loaded: Json | undefined;
    const wanted = input.nativeSessionId ?? this.sessionId;
    if (wanted) {
      if (live.sessionId !== wanted) {
        // session/load streams the whole history before it answers, so its
        // timeout is an idle window rather than a wall-clock limit.
        // Nothing streams while the agent is still starting, so the window
        // is the startup budget, not the handshake's.
        const loading = { ...control, idleReset: true };
        this.sessionTotals = {};
        if (capabilities.sessionCapabilities?.resume) loaded = await call('session/resume', { sessionId: wanted, cwd: input.cwd, mcpServers }, loading);
        else if (capabilities.loadSession) loaded = await call('session/load', { sessionId: wanted, cwd: input.cwd, mcpServers }, loading);
        else throw new Error(`${input.command} ACP cannot load sessions`);
        stillRunning();
        live.sessionId = wanted;
        live.models = loaded?.models ?? { configOptions: loaded?.configOptions };
        live.modes = loaded?.modes;
        live.configOptions = loaded?.configOptions;
        if (loaded) input.onSessionModels?.(loaded, false);
      }
      turn.sessionId = wanted;
    } else {
      this.sessionTotals = {};
      const started = await waitOnStart(call('session/new', { cwd: input.cwd, mcpServers }, control));
      stillRunning();
      const sessionId = String(started.sessionId ?? '');
      if (!sessionId) throw new Error(`${input.command} ACP did not return a session id`);
      live.sessionId = sessionId;
      live.models = started.models ?? { configOptions: started.configOptions };
      live.modes = started.modes;
      live.configOptions = started.configOptions;
      input.onSessionModels?.(started, true);
      turn.sessionId = sessionId;
    }
    // Agents that publish a model list take the choice over the protocol; a
    // launch flag is not guaranteed to reach the session (`hermes acp` ignores
    // `--model`, and would silently run its configured default).
    let requestedModel = input.model;
    if (requestedModel && providerConfigId && input.modelProviderSeparator && requestedModel.includes(input.modelProviderSeparator)) {
      const boundary = requestedModel.indexOf(input.modelProviderSeparator);
      const providerId = requestedModel.slice(0, boundary);
      requestedModel = requestedModel.slice(boundary + input.modelProviderSeparator.length);
      const providerOption = live.configOptions?.find((option) => (option.id ?? option.configId) === providerConfigId);
      const choices: Json[] = Array.isArray(providerOption?.options) ? providerOption.options : [];
      if (!choices.some((option) => option.value === providerId)) {
        throw Object.assign(new Error(`${input.command} ACP does not offer provider ${providerId}`), { acpUnsupportedModel: true });
      }
      if (providerOption?.currentValue !== providerId) {
        const updated = await startingRequest('session/set_config_option', { sessionId: turn.sessionId, configId: providerConfigId, value: providerId });
        stillRunning();
        live.configOptions = Array.isArray(updated?.configOptions)
          ? updated.configOptions
          : live.configOptions?.map((option) => option === providerOption ? { ...option, currentValue: providerId } : option);
        live.models = { configOptions: live.configOptions };
      }
    }
    const modelId = requestedModel ? acpModelChoice(live.models, requestedModel)
      ?? (providerConfigId && live.configOptions?.some((option) => (option.id ?? option.configId) === 'model') ? requestedModel : undefined)
      : undefined;
    if (input.model && !modelId && modelRequiresProtocol) {
      throw Object.assign(new Error(`${input.command} ACP does not list model ${input.model}`), { acpUnsupportedModel: true });
    }
    const modelConfig = live.configOptions?.find((option) => (option.id ?? option.configId) === 'model');
    const currentModel = live.models?.currentModelId ?? modelConfig?.currentValue;
    if (modelId && modelId !== currentModel) {
      if (modelConfig) await startingRequest('session/set_config_option', { sessionId: turn.sessionId, configId: 'model', value: modelId });
      else await startingRequest('session/set_model', { sessionId: turn.sessionId, modelId });
      stillRunning();
      if (modelConfig) live.configOptions = live.configOptions?.map((option) => option === modelConfig ? { ...option, currentValue: modelId } : option);
      else live.models = { ...live.models, currentModelId: modelId };
    }
    const modeId = permissionModeIds?.[input.permissionMode];
    if (modeId && live.modes?.currentModeId !== modeId) {
      const available: Json[] = Array.isArray(live.modes?.availableModes) ? live.modes.availableModes : [];
      if (!available.some((mode) => mode.id === modeId)) throw new Error(`${input.command} ACP does not offer permission mode ${modeId}`);
      await startingRequest('session/set_mode', { sessionId: turn.sessionId, modeId });
      stillRunning();
      live.modes = { ...live.modes, currentModeId: modeId };
    }
    if (input.effort && effortConfigId) {
      const effortOption = live.configOptions?.find((option) => (option.id ?? option.configId) === effortConfigId);
      const choices: Json[] = Array.isArray(effortOption?.options) ? effortOption.options : [];
      if (effortOption && choices.some((option) => option.value === input.effort) && effortOption.currentValue !== input.effort) {
        await startingRequest('session/set_config_option', { sessionId: turn.sessionId, configId: effortConfigId, value: input.effort });
        stillRunning();
        live.configOptions = live.configOptions?.map((option) => option === effortOption ? { ...option, currentValue: input.effort } : option);
      } else if ((!effortOption || !choices.some((option) => option.value === input.effort)) && effortRequiresProtocol) {
        throw Object.assign(new Error(`${input.command} ACP does not offer effort ${input.effort}`), { acpUnsupportedEffort: true });
      }
    } else if (input.effort && effortRequiresProtocol) {
      throw Object.assign(new Error(`${input.command} ACP does not offer effort control`), { acpUnsupportedEffort: true });
    }
    this.sessionId = turn.sessionId;
    if (!wanted) await input.onSessionId?.(turn.sessionId);
    stillRunning();
    const blocks: Json[] = [{ type: 'text', text: input.prompt }, ...await Promise.all(images.map(acpImageBlock))];
    stillRunning();
    // Taken now, not when the turn was created: a session/load above may have
    // reported the totals this turn is measured from.
    turn.base = { ...this.sessionTotals };
    await this.promptSent();
    stillRunning();
    turn.promptStarted = true;
    // The turn ends with the agent's answer to session/prompt. This is only
    // the ceiling for an agent that has stopped talking without answering.
    turn.watchdog = this.watchdog((afterMs) => turn.fail(turnIdleError(input.command, afterMs)));
    // No wall-clock timeout: a prompt legitimately runs for hours, and the
    // idle watchdog above is its only ceiling.
    turn.prompt = call('session/prompt', { sessionId: turn.sessionId, prompt: blocks }, {});
    if (live.steering) input.onSteerReady?.((text, hold) => this.steer(turn, text, hold));
    const completed = await turn.prompt as Json;
    // The answer ends the turn: nothing held can be steered into it any more
    // (each goes to the queue as the next turn), and one already sent is
    // answered before the turn is reported over.
    if (live.steering) input.onSteerReady?.(undefined);
    this.releaseSteers(turn);
    await turn.flushing;
    if (completed.stopReason === 'cancelled') throw turnCancelledError();
    // `end_turn`, or the reason the agent stopped short (max_tokens,
    // max_turn_requests, refusal), beside whatever usage it counted.
    // Gemini's ACP answers with `_meta.quota.token_count` {input_tokens,
    // output_tokens}, the turn's, beside the standard field.
    let usage = normalizeTurnUsage(completed.usage ?? completed._meta?.usage ?? completed._meta?.quota?.token_count);
    // Grok sends no usage_update. Its prompt result's `_meta.totalTokens` is
    // the context the session now occupies, and each listed model's
    // `_meta.totalContextTokens` its window.
    if (typeof completed._meta?.totalTokens === 'number') {
      const modelId = completed._meta.modelId ?? live.models?.currentModelId;
      const listed: Json[] = Array.isArray(live.models?.availableModels) ? live.models.availableModels : [];
      const window = listed.find((item) => item?.modelId === modelId)?._meta?.totalContextTokens;
      usage = { ...usage, contextUsed: completed._meta.totalTokens, ...(typeof window === 'number' ? { contextWindow: window } : {}) };
    }
    if (usage && usageTotals === 'session') {
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

  /** No tool call is open and the user is not being asked anything. Claude's
   * adapter injects a steer at once, which cancels a call in flight (verified
   * live: `[Request interrupted by user for tool use]`, the work redone) --
   * and a sub-agent's call is open for the sub-agent's whole run. Between
   * calls nothing is lost. */
  private steerSafe(turn: ActiveTurn): boolean {
    return !turn.done && this.turn === turn && this.pendingTools.size === 0 && turn.approvals === 0;
  }

  /** The turn's steer handler. Sent now when nothing would be interrupted;
   * otherwise held (and queued by the caller as the fallback) until the next
   * moment that is true. A caller that cannot hold gets a rejection: queue. */
  private steer(turn: ActiveTurn, text: string, hold?: (withdraw: () => boolean) => Promise<void>): Promise<void> {
    if (turn.done || this.turn !== turn) return Promise.reject(new Error(`${turn.input.command} ACP turn ended`));
    // Anything already held goes first: messages arrive in the order typed.
    const now = this.steerSafe(turn) && turn.held.length === 0 && !turn.flushing;
    if (!now && !hold) return Promise.reject(new Error(`${turn.input.command} is running a tool`));
    return new Promise<void>((resolve, reject) => {
      // Never sent once it is no longer the user's: its queued copy failed to
      // be written (the message went back to the composer), or was taken back.
      // False once it is on its way: it can no longer be taken back.
      const drop = (error: Error): boolean => {
        const index = turn.held.indexOf(item);
        if (index < 0) return false; // already sent, or released
        turn.held.splice(index, 1);
        reject(error);
        return true;
      };
      const ready = now ? Promise.resolve() : hold!(() => drop(new Error('taken back from the queue')));
      const item: HeldSteer = { text, ready, resolve, reject };
      turn.held.push(item);
      ready.catch((error: unknown) => drop(error instanceof Error ? error : new Error(String(error))));
      this.flushSteers(turn);
    });
  }

  /** Send what is held, oldest first, while it stays safe to. */
  private flushSteers(turn: ActiveTurn): void {
    const live = this.live;
    if (turn.flushing || !turn.held.length || !live || !this.steerSafe(turn)) return;
    turn.flushing = (async () => {
      while (turn.held.length && this.steerSafe(turn)) {
        const item = turn.held[0]!;
        try { await item.ready; } catch { continue; } // already taken out and rejected
        // Taken back while its fallback copy was being written.
        if (turn.held[0] !== item) continue;
        if (!this.steerSafe(turn)) break;
        turn.held.shift();
        try {
          // `promptRequired`: the agent has no turn running (it ended between
          // here and there); ClikCode owns the next turn, so the queued copy
          // runs. Never let the agent start a detached one (`startedNewTurn`).
          const answer = await live.peer.request('_session/steering', {
            sessionId: turn.sessionId, prompt: [{ type: 'text', text: item.text }],
            _meta: { steering: { idleBehavior: 'promptRequired' } },
          }, { timeoutMs: JSONRPC_SETUP_TIMEOUT_MS });
          if (answer?.outcome === 'injected') item.resolve();
          else item.reject(new Error(`${turn.input.command} did not take the message into its turn (${String(answer?.outcome)})`));
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })().finally(() => {
      turn.flushing = undefined;
      // Typed while the last one was being sent.
      this.flushSteers(turn);
    });
  }

  /** A moment that may be safe: look again once this burst of updates is in
   * (an agent announces parallel calls back to back). */
  private steerPause(turn: ActiveTurn): void {
    if (!turn.held.length) return;
    setImmediate(() => this.flushSteers(turn));
  }

  /** The turn is over: whatever is still held runs as the next turn. */
  private releaseSteers(turn: ActiveTurn): void {
    for (const item of turn.held.splice(0)) item.reject(new Error(`${turn.input.command} ACP turn ended`));
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
      if (target && target === this.turn && this.pendingTools.size === 0) this.steerPause(this.turn);
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
    // A sub-agent's prose and thinking (claude-agent-acp stamps each with the
    // Agent call it belongs to). It is not the answer: appended to it, the
    // sub-agent's words read as Claude's own. It shows under its Agent row.
    const parentId = acpParentToolId(update);
    if (parentId && (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk')) {
      const text = typeof update.content?.text === 'string' ? update.content.text : '';
      if (!text) return;
      target.subagentText ??= new Map();
      const prior = target.subagentText.get(parentId);
      const said = `${prior && prior.kind === update.sessionUpdate ? prior.text : ''}${text}`.slice(-2000);
      target.subagentText.set(parentId, { kind: String(update.sessionUpdate), text: said });
      const latest = said.trim().split(/\n+/).pop()?.trim() ?? '';
      if (latest) input.onActivity?.({ kind: 'thinking', label: latest.slice(-160), parentId });
      return;
    }
    const thought = acpThoughtDelta(update);
    // Anything but a thought (or a usage reading) ends the thought in progress.
    if (!thought && update.sessionUpdate !== 'usage_update') target.thought = undefined;
    const delta = acpResponseDelta(update);
    if (delta) {
      if (target.cumulativeChunks && typeof update.messageId === 'string') {
        const change = acpVibeResponseChange(target.messageText, delta);
        target.messageText = change.current;
        if (change.mode === 'replace') target.text = change.current;
        else target.text += change.text;
        input.onResponseDelta?.(change.text, change.mode);
      } else {
        const separator = target.needsSeparator && target.text
          ? (target.text.endsWith('\n\n') ? '' : target.text.endsWith('\n') ? '\n' : '\n\n') : '';
        target.needsSeparator = false;
        target.text += separator + delta;
        input.onResponseDelta?.(separator + delta);
      }
      return;
    }
    if (thought) {
      target.thought ??= { id: `thought-${++target.thoughts}`, text: '' };
      target.thought.text += thought;
      return input.onThought?.(target.thought.text, target.thought.id);
    }
    let activity = acpActivityEvent(update);
    if (activity) {
      target.settledTools ??= new Set();
      if (activity.id && activity.kind === 'tool-start' && target.settledTools.has(activity.id)) {
        // Late detail for a finished call: it settles into that row.
        activity = { ...activity, kind: 'tool-done' };
      } else if (activity.id && activity.kind !== 'tool-start') target.settledTools.add(activity.id);
      target.sawActivity = true;
      // A sub-agent's call ends what it was saying before it.
      if (activity.parentId) target.subagentText?.delete(activity.parentId);
      if (target.text && !activity.parentId) target.needsSeparator = true;
      input.onActivity?.(activity);
      return;
    }
    const plan = acpPlanEntries(update);
    if (plan) return input.onPlan?.(plan);
    // `usage_update` {used, size, cost}: the context the session occupies,
    // its window, and what it has cost -- live, while the turn runs.
    // claude-agent-acp forwards each rate_limit_event's info here: the 5-hour
    // and weekly windows, current as of this turn.
    const claudeLimits = update._meta?.['_claude/rateLimit'];
    if (claudeLimits && typeof claudeLimits === 'object' && target === this.turn) {
      const reading = claudeRateLimitReading(claudeLimits);
      if (reading) this.turn.input.onQuotaReading?.(reading);
    }
    if (update.sessionUpdate === 'usage_update' || (update.usage && typeof update.usage === 'object')) {
      const usage = normalizeTurnUsage(update.usage && typeof update.usage === 'object' ? update.usage : update) ?? {};
      // Its cost is the session's; the turn's is its share.
      if (update.sessionUpdate === 'usage_update') delete usage.costUsd;
      Object.assign(usage, share);
      if (Object.keys(usage).length) input.onUsage?.(usage);
    }
  }

  /** Kiro reports no tokens. Its `_kiro.dev/metadata` notification carries
   * the share of the context window in use and, once per turn, what the turn
   * cost in credits (`meteringUsage` [{value, unit: "credit"}]). Verified on
   * kiro-cli 2.23: credits arrive once, beside `turnDurationMs`. */
  private kiroMetadata(params: Json): void {
    const turn = this.turn;
    if (!turn || turn.done || !turn.promptStarted) return;
    if (typeof params.sessionId === 'string' && turn.sessionId && params.sessionId !== turn.sessionId) return;
    const usage: TurnUsage = {};
    if (typeof params.contextUsagePercentage === 'number' && Number.isFinite(params.contextUsagePercentage)) usage.contextPercent = params.contextUsagePercentage;
    const metered: Json[] = Array.isArray(params.meteringUsage) ? params.meteringUsage : [];
    const credits = metered.filter((item) => item?.unit === 'credit' && typeof item.value === 'number').reduce((sum, item) => sum + item.value, 0);
    if (metered.length && credits > 0) usage.credits = credits;
    if (Object.keys(usage).length) turn.input.onUsage?.(usage);
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
    // The call being asked about is open from here, whether or not the agent
    // announced it first: a steer now would cancel it once it runs.
    const callId = typeof params.toolCall?.toolCallId === 'string' ? params.toolCall.toolCallId as string : undefined;
    const opened = Boolean(turn && callId && !this.pendingTools.has(callId));
    if (opened) this.pendingTools.set(callId!, String(params.toolCall?.title ?? 'tool'));
    if (!accepted) {
      const title = String(params.toolCall?.title ?? params.toolCall?.name ?? 'Approve tool');
      const detail = [
        acpApprovalDetail(params.toolCall),
        plan.allowIsPersistent ? 'Approving grants this permanently: the agent offers no one-time option.' : undefined,
      ].filter(Boolean).join('\n') || undefined;
      // The agent is waiting on the user, not wedged.
      const resume = stream.watchdog?.pause();
      // Nothing is steered in while the user is being asked.
      if (turn) turn.approvals++;
      try {
        const diff = acpActivityEvent({ ...params.toolCall, sessionUpdate: 'tool_call' })?.diff;
        accepted = plan.allowOptionId !== undefined && await stream.observer.onApproval?.(title, detail, diff?.length ? { diff } : undefined) === true;
      } finally {
        resume?.();
        if (turn) {
          turn.approvals--;
          this.steerPause(turn);
        }
      }
    }
    // Refused, it never runs; an agent that reports it failed settles it too.
    if (opened && !accepted && turn) {
      this.pendingTools.delete(callId!);
      if (this.pendingTools.size === 0) this.steerPause(turn);
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
export function createAcpSession(options: PersistentSessionOptions = {}): AcpSession {
  return new AcpSessionImpl(options);
}

export function runAcpTurn(input: AcpTurnInput, options: PersistentSessionOptions = {}): Promise<AcpTurnResult> {
  return runOneTurn(createAcpSession(options), input);
}

/** Shared Agent Client Protocol transport. Providers that publish ACP can use
 * this one lifecycle/stream/approval implementation instead of accumulating
 * another vendor-shaped JSON parser. The existing CLI adapter remains the
 * compatibility fallback for products without ACP. */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AiHarnessAcpDefinition, AiHarnessPermissionMode } from '../definition.js';
import type { HarnessActivityEvent, ToolCategory } from '../prompter.js';
import type { HarnessAvailableCommand, HarnessPlanEntry, HarnessTurnObserver } from '../events/turn-observer.js';
import { askHarnessQuestion, type HarnessQuestionRequest, type HarnessQuestionResult } from '../events/question.js';
import { formToQuestions } from '../events/form-questions.js';
import { eventDiff } from '../../agent/line-diff.js';
import { commandOutcome } from '../protocol/activity-events.js';
import { categoryOf, commandText, formatToolRow, isAgentToolName, toolLabel } from '../protocol/tools.js';
import { acpSessionTotals, normalizeTurnUsage, turnShareOf, turnStopReason, type TurnUsage } from '../protocol/turn-usage.js';
import { claudeRateLimitReading } from '../accounts/usage-reading.js';
import { activityOutput, editDiffFromInput, toolCall } from '../protocol/activity-events.js';
import { turnCancelledError } from '../../agent/cancellation.js';
import { type JsonRpcPeer } from './jsonrpc-peer.js';
import { BackgroundTurnChannel } from './background-turn.js';
import { PersistentSession, runOneTurn, turnFailure, type PersistentSessionOptions } from './persistent-session.js';
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { backgroundWork, mergeBackgroundWork, type BackgroundWork } from '../protocol/background-agents.js';
import { markTurn } from '../../runtime/turn-latency.js';

type Json = Record<string, any>;

/** Tool kinds that cannot change the workspace or run code. `auto` approves
 * only these; everything else still reaches the user. */
const READ_LIKE_TOOL_KINDS: ReadonlySet<string> = new Set(['read', 'search', 'think', 'fetch']);
const DETAIL_LINE_CAP = 12;
/** How long an agent may take to answer before the wait is named. */
const START_NOTICE_MS = 1_000;

/** The raw SDK frames claude-agent-acp is asked to forward as
 * `_claude/sdkMessage` (`_meta.claudeCode.emitRawSDKMessages`, a type/subtype
 * filter, claude-agent-acp 0.84): only the background-task level, which says
 * how many background agents are still running when the turn ends. An agent
 * that does not know the key ignores it. */
const ACP_SESSION_META = {
  claudeCode: { emitRawSDKMessages: [{ type: 'system', subtype: 'background_tasks_changed' }] },
} as const;

/** What this client can show. `terminal_output`: a command's output and exit
 * code as `_meta.terminal_output` / `_meta.terminal_exit` (claude-agent-acp's
 * terminal extension, as codex-acp does) rather than a fenced text block with
 * no exit code. An agent that does not know the key ignores it. */
const ACP_CLIENT_CAPABILITIES = {
  _meta: { terminal_output: true },
  // claude-agent-acp (0.84) sends a vendor warning as a structured `notice`
  // update when the client advertises `session.notices`, instead of appending
  // it to the answer as a bold line. Handled in `deliver` (onNotice).
  // `elicitation.form`: claude-agent-acp turns AskUserQuestion (and an MCP
  // server's form) into an `elicitation/create` request only when the client
  // says it can render one; the handler is `elicitation` below, which puts the
  // form to the user through the observer's question channel. NOT advertised:
  // the AIR `sessionFailure`/`asyncTasks`/`nativeSubagentSessions` opt-ins,
  // which need the jetbrains.air identity and replace the raw error text the
  // failover classifier reads.
  elicitation: { form: {} },
  session: { notices: {} },
};

export interface AcpTurnInput extends HarnessTurnObserver {
  binary: string;
  command: string;
  cwd: string;
  /** Extra roots the agent may work in (`/add-dir`): sent with session/new|load|resume when the agent advertises `sessionCapabilities.additionalDirectories`. */
  additionalDirectories?: readonly string[];
  prompt: string;
  nativeSessionId?: string;
  environment: Readonly<Record<string, string>>;
  permissionMode: AiHarnessPermissionMode;
  /** The mode as it stands when the agent asks to run a tool: a switch made while the turn runs applies to the next ask. */
  currentPermissionMode?: () => Promise<AiHarnessPermissionMode | undefined>;
  model?: string | null;
  effort?: string | null;
  /** The harness's catalog ACP entry: how model, effort and permission mode
   * are selected over the protocol, and what its usage readings mean. */
  acp?: Pick<AiHarnessAcpDefinition, 'inheritCliOptions' | 'effortConfigId' | 'providerConfigId' | 'permissionModeIds' | 'planModeId' | 'usageTotals' | 'cumulativeChunks' | 'steering'>;
  /** The chat's Plan mode is on: the session runs in `acp.planModeId`; the
   * agent leaving it is onPlanModeExit. */
  planMode?: boolean;
  modelProviderSeparator?: string;
  /** The session lists only what the account's plan runs (catalog
   * `freePlan.listed`): a model it leaves out is refused, not swapped for
   * the vendor's default while ClikCode records the one asked for (Devin
   * took `--model swe-2-medium` on a Free plan and ran swe-1-6-slow). */
  plansListModels?: boolean;
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
  /** Open the session -- start the agent, load the thread, apply model,
   *  mode and effort -- and stop before the prompt: the next turn on this
   *  session then starts at the prompt (a failover's standby account). */
  prepareOnly?: boolean;
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

/** The field names agents use for "this update belongs to that tool call":
 * claude-agent-acp's `claudeCode.parentToolUseId`, Qwen Code's
 * `_meta.parentToolCallId` (+ `subagentType`), and the snake_case forms of
 * both. Read from the update itself, its `_meta`, or one vendor namespace
 * inside `_meta` -- never from `rawInput`, which is the call's own argument. */
const PARENT_KEYS = ['parentToolUseId', 'parentToolCallId', 'parent_tool_use_id', 'parent_tool_call_id'] as const;

function parentIn(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  for (const key of PARENT_KEYS) {
    const value = (record as Json)[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** The tool call a sub-agent's update belongs to (stamped on the sub-agent's
 * tool calls, prose and thinking), whichever agent says so. */
export function acpParentToolId(update: Json): string | undefined {
  const meta = update?._meta && typeof update._meta === 'object' ? update._meta as Json : undefined;
  const direct = parentIn(update) ?? parentIn(meta);
  if (direct || !meta) return direct;
  for (const namespace of Object.values(meta)) {
    const nested = parentIn(namespace);
    if (nested) return nested;
  }
  return undefined;
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
  const agent = isAgentToolName(head) || isAgentToolName(String(update.tool ?? '')) || typeof raw?.subagent_type === 'string' ? true as const : undefined;
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

/** Cursor's fallback for a client without `cursor/ask_question` (cursor-agent
 * 2026.09.26, read from its bundle): each question is asked as a
 * session/request_permission with one `allow_once` option per ANSWER, a
 * `reject_once` Skip whose id is this, and a toolCallId `<call>_q<n>`. Approving
 * "allow_once" there is not consent to a tool: it is picking an answer. */
const CURSOR_QUESTION_SKIP_ID = '__ask_question_skip__';

/** A permission request that is really a question to the user. */
function acpQuestionPermission(params: Json): { skipOptionId: string; prompt: string; answers: string[]; choices: { optionId: string; name: string }[] } | undefined {
  const options: Json[] = Array.isArray(params.options) ? params.options : [];
  const skip = options.find((option) => option?.optionId === CURSOR_QUESTION_SKIP_ID);
  if (!skip) return undefined;
  const choices = options.filter((option) => option !== skip && typeof option?.name === 'string' && option.optionId !== undefined)
    .map((option) => ({ optionId: String(option.optionId), name: String(option.name) }));
  return {
    skipOptionId: CURSOR_QUESTION_SKIP_ID,
    prompt: String(params.toolCall?.title ?? params.toolCall?.content?.[0]?.content?.text ?? 'a question'),
    answers: choices.map((choice) => choice.name),
    choices,
  };
}

/** Claude Code's ExitPlanMode arrives as a permission request whose options
 * are the ways to leave plan mode (claude-agent-acp permissions/options/
 * tools.js): "Yes, clear context and ...", "Yes, and use auto mode", "Yes,
 * manually approve edits", "No, keep planning". Picking one is the user's
 * decision about the plan, not consent to a tool, so no permission mode may
 * choose it. */
function acpPlanChoices(params: Json): { plan?: string; choices: { optionId: string; name: string }[] } | undefined {
  const options: Json[] = Array.isArray(params.options) ? params.options : [];
  const choices = options.filter((option) => typeof option?.name === 'string' && option.optionId !== undefined)
    .map((option) => ({ optionId: String(option.optionId), name: String(option.name) }));
  if (!choices.some((choice) => choice.optionId.startsWith('exit-plan-'))) return undefined;
  const plan = params.toolCall?.rawInput?.plan;
  return { ...(typeof plan === 'string' && plan.trim() ? { plan: plan.trim() } : {}), choices };
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

/** What an agent answers a prompt with when it is still busy with an earlier
 * one (Hermes: "Queued for the next turn. (1 queued)", "Stopped") -- a notice,
 * not an answer. ClikCode queues nothing at the agent, so a reply that is only
 * this is the cancelled turn still alive in the process. "Stopped" is read so
 * only straight after a cancel: otherwise it may be what the agent meant. */
export function vendorBusyNotice(text: string, afterCancel: boolean): boolean {
  const plain = text.trim().replace(/^[^\w]+/, '');
  if (/^queued for the next turn\.?(?:\s*\(\d+ queued\))?\.?$/i.test(plain)) return true;
  return afterCancel && /^(?:stopped|interrupted|cancelled|canceled)\.?$/i.test(plain);
}

/** Lines an agent prints as it starts, not as it fails ("[acp] starting ACP
 * mode over stdio..."). Read as the failure, Cline's refusal of an empty
 * balance showed as this banner. */
const STARTUP_BANNER = /^\s*(?:\[acp\]|(?:info|debug|trace)\b|.*\bstarting (?:acp|the agent|agent)\b|.*\blistening on\b)/i;
const FAILURE_WORDS = /insufficient|balance|credit|quota|limit|unauthori[sz]ed|not logged in|sign.?in|invalid|denied|forbidden|exceeded|rate|billing|payment|\b(?:error|fail(?:ed|ure)?|fatal|panic)\b|\b(?:401|402|403|429)\b/i;

/** The vendor's own words out of a dead child's output: startup banner lines
 * dropped, the line that says why it failed first. */
export function acpFailureMessage(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !STARTUP_BANNER.test(line));
  if (!lines.length) return '';
  const why = lines.findIndex((line) => FAILURE_WORDS.test(line));
  return (why > 0 ? [lines[why]!, ...lines.slice(0, why), ...lines.slice(why + 1)] : lines).join('\n');
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
  // An alias the vendor's CLI takes for one of the agent's full ids: Claude
  // Code's `--model fable` is `claude-fable-5-1` over ACP. Only when exactly
  // one id carries the alias as a whole word; "fable" was refused as not
  // offered, and the turn fell back to the CLI for no reason.
  const word = model.toLowerCase();
  const aliased = /^[a-z][a-z0-9]*$/.test(word) ? ids.filter((id) => id.toLowerCase().split(/[^a-z0-9]+/).includes(word)) : [];
  if (aliased.length === 1) return aliased[0];
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


/** The config option an agent uses for its modes when it has no `modes` object. */
function acpModeConfigOption(options: readonly Json[] | undefined): Json | undefined {
  return options?.find((option) => option?.category === 'mode') ?? options?.find((option) => (option?.id ?? option?.configId) === 'mode');
}

/** Every value a select option offers, grouped or flat. */
function acpConfigValues(option: Json): string[] {
  const entries: Json[] = Array.isArray(option?.options) ? option.options : [];
  return entries.flatMap((entry) => Array.isArray(entry?.options) ? entry.options : [entry])
    .map((entry) => entry?.value).filter((value): value is string => typeof value === 'string');
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
  /** A prompt of this process was cancelled: the agent may still be unwinding
   * it when the next prompt arrives (see vendorBusyNotice). */
  cancelled?: boolean;
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
}

interface ActiveTurn extends Stream {
  input: AcpTurnInput;
  promptStarted: boolean;
  done: boolean;
  sessionId?: string;
  prompt?: Promise<unknown>;
  fail: (error: Error) => void;
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
/** What a sub-agent's session contributes to the turn it runs under. */
const CHILD_SESSION_UPDATES: ReadonlySet<string> = new Set(['tool_call', 'tool_call_update', 'agent_message_chunk', 'agent_thought_chunk']);
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
  private readonly pendingAgents = new Set<string>();
  /** The background work the vendor's level says is running (claude-agent-acp's
   * `_claude/sdkMessage` background_tasks_changed). Kept between turns: it
   * holds the worker while anything runs, tells the next turn and the
   * background turn what is going on, and ends the background turn when it
   * empties. A level is per vendor process: it resets with the live child. */
  private backgroundLevel?: BackgroundWork;
  private sessionId?: string;
  private lastCumulativeChunks = false;
  /** The agent's out-of-turn message so far, for an agent that re-sends it whole. */
  private relayedMessage = '';
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
    this.relayedMessage = '';
    // What already runs (a terminal an earlier turn started) is the new
    // turn's indicator from its first frame.
    if (this.backgroundLevel) input.onBackgroundWork?.(this.fullLevel());
    return this.runActive(turn, input.signal, failure, () => this.flow(turn, argv).catch((error: unknown) => {
      if (!(error as { acpStaleTurn?: boolean } | null)?.acpStaleTurn || turn.done) throw error;
      // The prompt went to the cancelled turn's process, which is gone now:
      // the same prompt, once, on a fresh process that resumes the session.
      Object.assign(turn, { text: '', messageText: '', sawActivity: false, thoughts: 0, promptStarted: false, prompt: undefined, thought: undefined, sessionId: undefined });
      return this.flow(turn, argv);
    }), {
      failed: (error) => {
        // A child that died says why on its stderr, after its startup banner.
        if ((error as { code?: unknown }).code === 'ERR_JSONRPC_CLOSED') {
          const why = acpFailureMessage(error.message);
          if (why) error.message = why;
        }
        // The parent may have failed while a tool is still active.
        // Its child is the only process that can finish that tool; keep it
        // until the tool settles, even though this parent prompt failed.
        if (!this.pendingTools.size) this.dropLive(error);
      },
      ended: () => {
        input.onSteerReady?.(undefined);
        this.releaseSteers(turn);
        this.live?.peer.rejectPending(new Error(`${input.command} ACP turn ended`), (method) => method !== 'session/prompt');
        // An unsettled tool call belongs to the still-live vendor, even
        // after its parent request ends. Route its later events into the
        // worker's background turn and keep the process alive until it ends.
        if (this.live && (this.pendingTools.size || this.backgroundLevel)) {
          const run = this.openBackground('background-work');
          if (run) {
            // What runs now is the background turn's indicator from its first frame.
            if (this.backgroundLevel) run.observer.onBackgroundWork?.(this.fullLevel());
            return;
          }
        }
        this.clearPending();
      },
    });
  }

  protected clearPending(): void {
    this.pendingTools.clear();
    this.pendingAgents.clear();
    this.backgroundLevel = undefined;
  }

  /** The level with every kind named (a zero is "none", not unknown). */
  private fullLevel(): { agents: number; terminals: number; workflows: number } {
    const level = this.backgroundLevel ?? {};
    return { agents: level.agents ?? 0, terminals: level.terminals ?? 0, workflows: level.workflows ?? 0 };
  }

  protected hasActiveSubagents(): boolean { return this.pendingAgents.size > 0; }

  protected pendingCount(): number {
    // Cleared at each answer (see `ended` above): between turns only tools a
    // background turn is following count, and the work the vendor's own
    // level says still runs.
    const level = this.backgroundLevel;
    return this.background ? this.pendingTools.size + (level ? (level.agents ?? 0) + (level.terminals ?? 0) + (level.workflows ?? 0) : 0) : 0;
  }

  protected interrupt(turn: ActiveTurn, live: LiveAgent): boolean {
    const prompt = turn.prompt;
    if (!prompt || !turn.sessionId) return false;
    // The agent answers the prompt with stopReason `cancelled` once it has
    // unwound. Give it two seconds so the session stays resumable.
    live.peer.notify('session/cancel', { sessionId: turn.sessionId });
    live.cancelled = true;
    this.settleCancel(live, (settled) => void prompt.then(() => undefined, () => undefined).then(settled));
    return true;
  }

  /** Open a background turn for the agent's out-of-turn updates. */
  private openBackground(reason: 'vendor-turn' | 'background-work' = 'vendor-turn'): BackgroundRun | undefined {
    return this.openBackgroundRun(() => {
      const channel = new BackgroundTurnChannel('acp', reason);
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
        onRequest: (method, params, id) => method === 'session/request_permission' ? this.permission(params, id)
          : method === 'elicitation/create' ? this.elicitation(params, id) : undefined,
        onNotification: (method, params) => {
          if (method === 'session/update') this.update(params);
          else if (method === '$/cancel_request') this.withdrawn(params.requestId);
          else if (method === '_session/retrying') this.retrying(params);
          else if (method.startsWith('_') && method !== '_kiro.dev/metadata') this.extension(method, params);
          else if (method === '_kiro.dev/metadata') this.kiroMetadata(params);
        },
      },
    }, {});
  }

  private async flow(turn: ActiveTurn, argv: readonly string[]): Promise<AcpTurnResult> {
    const { input } = turn;
    const setupAt = Date.now();
    const live = this.ensureLive(input, argv);
    const cold = !live.capabilities;
    let threadLoadMs = 0;
    const { peer } = live;
    // Setup requests carry no clock. A starting agent answers when it is ready
    // (cold start under load is slow, not broken); a dead one rejects them when
    // its process exits, and Esc or the turn ending rejects them too.
    const setup: { timeoutMs?: number } = {};
    // Past the handshake, a request waits on the agent's backend, which is
    // still starting: Claude Code connects every MCP server before it takes a
    // control request, and its adapter answers set_config_option only once
    // Claude Code has. That can take far longer than a handshake, and is not a
    // fault. No clock; Esc still cancels it.
    const control: { timeoutMs?: number } = {};
    // Said once, only for an agent this turn started (one already running
    // answers at once), and only when it is slow to: not a flash every turn.
    let announced = Boolean(live.capabilities);
    let connectingShown = false;
    const waitOnStart = async <T>(pending: Promise<T>): Promise<T> => {
      if (announced) return pending;
      const notice = setTimeout(() => { announced = true; connectingShown = true; input.onPhase?.(`connecting to ${input.command}`); }, START_NOTICE_MS);
      notice.unref?.();
      try { return await pending; } finally { clearTimeout(notice); }
    };
    const startingRequest = (method: string, params: Json): Promise<Json> => waitOnStart(peer.request(method, params, control));
    const stillRunning = (): void => { if (turn.done) throw turnCancelledError(); };
    const { effortConfigId, providerConfigId, permissionModeIds, planModeId, usageTotals } = input.acp ?? {};
    // CLI launch flags are not valid for this agent's ACP entry point: model
    // and effort can only be selected over the protocol.
    const modelRequiresProtocol = input.acp?.inheritCliOptions === false;
    // "medium" is ClikCode's generic initial value. Agents without an ACP
    // effort control should use their own default instead of sending every
    // ordinary turn through the CLI fallback.
    const effortRequiresProtocol = modelRequiresProtocol && input.effort !== 'medium';
    if (!live.capabilities) {
      const initialized = await waitOnStart(peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: ACP_CLIENT_CAPABILITIES,
        clientInfo: { name: 'clikcode', title: 'ClikCode', version: '1' },
      }, setup));
      live.capabilities = (initialized.agentCapabilities as Json | undefined) ?? {};
      live.steering = initialized._meta?.steering?.supported === true && input.acp?.steering !== false;
      stillRunning();
    }
    // A vendor that says it is signed out is not signed in over ACP
    // (`authenticate`): its own browser login showed no link on ClikCode's
    // screen and, from a phone, waited for ever (Devin, 2026-10-06). The error
    // reaches the turn, which signs in on ClikCode's screen like any other.
    const call = (method: string, params: Json, options: { timeoutMs?: number } = setup): Promise<Json> =>
      peer.request(method, params, options);
    const capabilities = live.capabilities;
    const directories = input.additionalDirectories ?? [];
    if (directories.length && !capabilities.sessionCapabilities?.additionalDirectories) {
      throw new Error(`${input.command} ACP does not accept additional directories (/add-dir); remove them or start from a common parent directory`);
    }
    const sessionParams = { cwd: input.cwd, mcpServers: [], _meta: ACP_SESSION_META, ...(directories.length ? { additionalDirectories: [...directories] } : {}) };
    const images = input.images ?? [];
    if (images.length && capabilities.promptCapabilities?.image !== true) {
      throw Object.assign(new Error(`${input.command} ACP does not accept image prompts`), { acpUnsupportedImages: true });
    }
    let loaded: Json | undefined;
    const wanted = input.nativeSessionId ?? this.sessionId;
    // The session this process has open is closed before another is opened on it. An agent keeps
    // every session it was given until told otherwise -- claude-agent-acp runs a whole Claude CLI
    // (and its MCP servers) per session: MEASURED 2026-10-10, one worker held five of them, each
    // with a full set of MCP servers, after its conversation's thread moved between accounts.
    if (live.sessionId && live.sessionId !== wanted && capabilities.sessionCapabilities?.close) {
      const previous = live.sessionId;
      live.sessionId = undefined;
      // fail-open-ok: the agent ending it already, or not knowing it, leaves nothing to close.
      await call('session/close', { sessionId: previous }).catch(() => undefined);
    }
    if (wanted) {
      if (live.sessionId !== wanted) {
        // No clock on the load either: it streams the whole history, or
        // answers when a starting agent is ready. A dead agent rejects it on
        // exit, Esc or the turn ending rejects it, and the `connecting` phase
        // says what it waits on.
        this.sessionTotals = {};
        if (!capabilities.sessionCapabilities?.resume && !capabilities.loadSession) throw new Error(`${input.command} ACP cannot load sessions`);
        const method = capabilities.sessionCapabilities?.resume ? 'session/resume' : 'session/load';
        try {
          const loadAt = Date.now();
          loaded = await waitOnStart(call(method, { sessionId: wanted, ...sessionParams }, setup));
          threadLoadMs = Date.now() - loadAt;
        } catch (error) {
          throw markMissingThread(error, wanted);
        }
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
      const started = await waitOnStart(call('session/new', sessionParams, setup));
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
    const offersModels = (Array.isArray(live.models?.availableModels) && live.models.availableModels.length > 0)
      || Boolean(live.configOptions?.some((option) => (option.id ?? option.configId) === 'model' && Array.isArray(option.options) && option.options.length > 0));
    if (input.model && !modelId && (modelRequiresProtocol || (input.plansListModels && offersModels))) {
      throw Object.assign(new Error(`${input.command} ACP does not list model ${input.model}`), { acpUnsupportedModel: true });
    }
    const modelConfig = live.configOptions?.find((option) => (option.id ?? option.configId) === 'model');
    const currentModel = live.models?.currentModelId ?? modelConfig?.currentValue;
    if (modelId && modelId !== currentModel) {
      const updated = modelConfig
        ? await startingRequest('session/set_config_option', { sessionId: turn.sessionId, configId: 'model', value: modelId })
        : await startingRequest('session/set_model', { sessionId: turn.sessionId, modelId });
      stillRunning();
      // The options the model now has, as the agent returns them: a model
      // without effort (Claude's Haiku) drops that option, and setting it
      // from the old list failed the turn with "Unknown config option".
      if (Array.isArray(updated?.configOptions)) {
        live.configOptions = updated.configOptions;
        live.models = { ...live.models, configOptions: live.configOptions };
      } else if (modelConfig) live.configOptions = live.configOptions?.map((option) => option === modelConfig ? { ...option, currentValue: modelId } : option);
      if (!modelConfig) live.models = { ...live.models, currentModelId: modelId };
    }
    const planning = Boolean(input.planMode && planModeId);
    const modeId = planning ? planModeId : permissionModeIds?.[input.permissionMode];
    if (modeId) {
      const available: Json[] = Array.isArray(live.modes?.availableModes) ? live.modes.availableModes : [];
      // Goose, Devin, OpenCode, Kilo, Qwen and Cline publish their modes as a
      // config option (`category: "mode"`) and no `modes` object.
      const modeOption = available.length ? undefined : acpModeConfigOption(live.configOptions);
      if (modeOption) {
        if (modeOption.currentValue !== modeId) {
          if (!acpConfigValues(modeOption).includes(modeId)) throw new Error(`${input.command} ACP does not offer ${planning ? 'plan' : 'permission'} mode ${modeId}`);
          const updated = await startingRequest('session/set_config_option', { sessionId: turn.sessionId, configId: modeOption.id ?? modeOption.configId, value: modeId });
          stillRunning();
          live.configOptions = Array.isArray(updated?.configOptions)
            ? updated.configOptions
            : live.configOptions?.map((option) => option === modeOption ? { ...option, currentValue: modeId } : option);
          live.models = { ...live.models, configOptions: live.configOptions };
        }
      } else if (live.modes?.currentModeId !== modeId) {
        if (!available.some((mode) => mode.id === modeId)) throw new Error(`${input.command} ACP does not offer ${planning ? 'plan' : 'permission'} mode ${modeId}`);
        await startingRequest('session/set_mode', { sessionId: turn.sessionId, modeId });
        stillRunning();
        live.modes = { ...live.modes, currentModeId: modeId };
      }
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
    if (input.prepareOnly) {
      lifecycle('vendor.acp.prepared', { harness: input.command, cold, setupMs: Date.now() - setupAt, threadLoadMs });
      return { text: '', nativeSessionId: turn.sessionId! };
    }
    // Handshake, session, model and mode are all in place.
    markTurn('ready', { cold });
    const blocks: Json[] = [{ type: 'text', text: input.prompt }, ...await Promise.all(images.map(acpImageBlock))];
    stillRunning();
    // Taken now, not when the turn was created: a session/load above may have
    // reported the totals this turn is measured from.
    turn.base = { ...this.sessionTotals };
    await this.promptSent();
    stillRunning();
    lifecycle('vendor.acp.ready', { harness: input.command, cold, setupMs: Date.now() - setupAt, threadLoadMs });
    turn.promptStarted = true;
    // "connecting to …" was true until here; left up, it read as stuck for as long as the agent thought.
    if (connectingShown) input.onPhase?.('thinking');
    // The turn ends with the agent's answer to session/prompt, or the user
    // stopping it: no silence ceiling. No wall-clock timeout: a prompt legitimately runs for hours.
    turn.prompt = call('session/prompt', { sessionId: turn.sessionId, prompt: blocks }, {});
    markTurn('prompt-sent');
    if (live.steering) input.onSteerReady?.((text, hold) => this.steer(turn, text, hold));
    const completed = await turn.prompt as Json;
    // The answer ends the turn: nothing held can be steered into it any more
    // (each goes to the queue as the next turn), and one already sent is
    // answered before the turn is reported over.
    if (live.steering) input.onSteerReady?.(undefined);
    this.releaseSteers(turn);
    await turn.flushing;
    if (completed.stopReason === 'cancelled') {
      // Nothing here asked for it and nothing was said or done first: the agent
      // gave up the prompt by itself (Junie does, signed out and in a sandbox
      // that cannot read its keyring), which must not read as a quiet stop.
      if (!live.cancelled && !turn.sawActivity && !turn.text.trim()) {
        throw new Error(`${input.command} ended the turn as cancelled before saying anything, which it does when its sign-in is not usable; check \`clikcode accounts status\``);
      }
      throw turnCancelledError();
    }
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
    // Only a notice that the agent is still busy with the cancelled turn: not
    // an answer, never stored as one.
    if (vendorBusyNotice(text, live.cancelled === true) && !turn.sawActivity) {
      this.dropLive(new Error(`${input.command} ACP restarted`));
      throw Object.assign(new Error(`${input.command} was still finishing the cancelled turn and answered "${text}" instead of the message`), { acpStaleTurn: true });
    }
    live.cancelled = false;
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
          }, {});
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
    // Only a tool the vendor reports running opens a "working" background turn.
    // Prose with no open tool is relayed (relayOutOfTurn), never worked on.
    const reportsRunning = update.sessionUpdate === 'tool_call' ? toolRunning(update)
      : update.sessionUpdate === 'tool_call_update' && (update.status === 'in_progress' || update.status === 'pending');
    return reportsRunning ? this.openBackground() : undefined;
  }

  /** What the agent says with no prompt open and no tool running: its words
   * go into the conversation as they arrive. It is not work in progress, so
   * nothing is shown as working for it. */
  private relayOutOfTurn(update: Json): void {
    if (!this.live || this.isClosed || this.settling || !this.relay) return;
    const name = String(update.sessionUpdate);
    if (name !== 'agent_message_chunk' && name !== 'agent_thought_chunk') return;
    const kind = name === 'agent_message_chunk' ? 'message' as const : 'thought' as const;
    const delta = kind === 'message' ? acpResponseDelta(update) : acpThoughtDelta(update);
    if (!delta) return;
    if (kind === 'message' && this.lastCumulativeChunks && typeof update.messageId === 'string') {
      const change = acpVibeResponseChange(this.relayedMessage, delta);
      this.relayedMessage = change.current;
      this.relay({ kind, text: change.text, mode: change.mode });
      return;
    }
    this.relay({ kind, text: delta, mode: 'append' });
  }

  /** Sessions an agent runs a sub-agent in (cursor-agent: `subagent_spawned`
   * names `subagentSessionId` and, in `_meta.cursor.toolCallId`, the call that
   * spawned it) -> that call. Their updates arrive under their own session id. */
  private readonly childSessions = new Map<string, string>();

  private update(params: Json): void {
    let update: Json = params.update ?? {};
    const turn = this.turn && !this.turn.done ? this.turn : undefined;
    const expected = turn?.sessionId ?? this.sessionId;
    if (update.sessionUpdate === 'subagent_spawned' && typeof update.subagentSessionId === 'string') {
      const spawner = update._meta?.cursor?.toolCallId;
      if (typeof spawner === 'string' && spawner) {
        // A sub-agent's own sub-agent hangs off the call in its session, itself a child.
        this.childSessions.set(update.subagentSessionId, spawner);
      }
    }
    let ofChild = false;
    if (typeof params.sessionId === 'string' && expected && params.sessionId !== expected) {
      // A sub-agent's session: its calls, prose and thoughts are children of
      // the call that spawned it. Its plan, usage totals and commands are its own.
      const parent = this.childSessions.get(params.sessionId);
      if (!parent || !CHILD_SESSION_UPDATES.has(String(update.sessionUpdate))) return;
      update = { ...update, _meta: { ...(update._meta && typeof update._meta === 'object' ? update._meta : {}), parentToolCallId: parent } };
      ofChild = true;
    }
    // The agent changed its own mode: leaving plan mode is its plan approved.
    if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string' && this.live) {
      const before = this.live.modes?.currentModeId;
      this.live.modes = { ...this.live.modes, currentModeId: update.currentModeId };
      const planModeId = turn?.input.acp?.planModeId;
      if (turn?.promptStarted && planModeId && before === planModeId && update.currentModeId !== planModeId) turn.input.onPlanModeExit?.();
    }
    // The agent's option list as it stands now (a model change drops options).
    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions) && this.live) {
      // Plan mode kept as a config option: the agent leaving it is its plan approved.
      const planModeId = turn?.input.acp?.planModeId;
      const was = acpModeConfigOption(this.live.configOptions)?.currentValue;
      const now = acpModeConfigOption(update.configOptions)?.currentValue;
      if (turn?.promptStarted && planModeId && was === planModeId && now !== undefined && now !== planModeId) turn.input.onPlanModeExit?.();
      this.live.configOptions = update.configOptions;
      this.live.models = { ...this.live.models, configOptions: update.configOptions };
    }
    // Running totals are the session's, whoever is listening: taken during a
    // session/load replay (the baseline) and after a prompt was answered.
    const totals = ofChild ? undefined : acpSessionTotals(update);
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
    if (!target && !this.turn) this.relayOutOfTurn(update);
    this.trackTool(target, update);
    if (target) this.deliver(target, update, totals);
    const run = this.background;
    if (run && target === run && this.pendingTools.size === 0) {
      // The end of a background turn is the vendor's to say: the last tool it
      // was waiting for settled, or the agent's own end-of-turn bookkeeping
      // arrived. Nothing else ends it but the process going or the user.
      const settledLastTool = update.sessionUpdate === 'tool_call_update' && toolSettled(update);
      if (settledLastTool || TURN_BOOKKEEPING_UPDATES.has(String(update.sessionUpdate))) this.finishBackground('completed');
    }
  }

  /** Updates that are the agent's status, not its content: shown as the
   * waiting line (a warning as a notice) so a turn emitting only these is
   * seen to be working. */
  private statusUpdate(input: HarnessTurnObserver, update: Json): boolean {
    const name = (value: unknown, fallback: string): string => typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : fallback;
    switch (update.sessionUpdate) {
      case 'notice': {
        // A structured warning (client capability `session.notices`).
        const title = typeof update.title === 'string' ? update.title.trim() : '';
        const description = typeof update.description === 'string' ? update.description.trim() : '';
        const text = [title, description].filter(Boolean).join(': ');
        if (text) input.onNotice?.(text);
        return true;
      }
      case 'compaction_update': {
        const status = String(update.status ?? '');
        if (status === 'completed') input.onNotice?.('Conversation compacted to fit the context window');
        else if (status !== 'cancelled' && status !== 'failed') input.onPhase?.('compacting the conversation');
        return true;
      }
      case 'compaction_summary_chunk':
        input.onPhase?.('compacting the conversation');
        return true;
      case 'async_task_spawned':
      case 'async_task_progress':
      case 'async_task_state_update':
        input.onPhase?.(`background task: ${name(update.name ?? update.description, String(update.asyncTaskId ?? 'running'))}`);
        return true;
      case 'subagent_spawned':
      case 'subagent_state_update':
        input.onPhase?.(`sub-agent: ${name(update.name ?? update.description ?? update.title, 'working')}`);
        return true;
      case 'config_option_update':
        return true;
      default:
        return false;
    }
  }

  private trackTool(target: Stream | undefined, update: Json): void {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    if (!id) return;
    if (toolSettled(update)) {
      this.pendingTools.delete(id);
      this.pendingAgents.delete(id);
      if (target && target === this.turn && this.pendingTools.size === 0) {
        this.steerPause(this.turn);
      }
    } else if (update.sessionUpdate === 'tool_call' ? toolRunning(update) : update.status === 'in_progress' || update.status === 'pending') {
      if (!this.pendingTools.has(id)) this.pendingTools.set(id, String(update.title ?? 'tool'));
      if (acpActivityEvent(update)?.agent) this.pendingAgents.add(id);
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
    if (this.statusUpdate(input, update)) return;
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
   * Shown as a phase, nothing more: the agent retries by its own backoff and
   * may well succeed. Its own failure or stop reason ends the turn. */
  private retrying(params: Json): void {
    const target = this.liveTarget(params);
    if (!target) return;
    const command = this.turn?.input.command ?? 'the agent';
    const detail = typeof params.detail === 'string' ? params.detail : '';
    const category = typeof params.category === 'string' ? params.category : '';
    target.observer.onPhase?.(`${command} is retrying${category || detail ? ` (${[category.replace(/_/g, ' '), detail].filter(Boolean).join(': ')})` : ''}`);
  }

  /** Where a session-scoped extension notification goes: the user's turn, or
   * the background turn. A notice for another session is not ours. */
  private liveTarget(params: Json): Stream | undefined {
    const expected = this.turn?.sessionId ?? this.sessionId;
    if (typeof params.sessionId === 'string' && expected && params.sessionId !== expected) return undefined;
    const target: Stream | undefined = this.turn ? (this.turn.done || !this.turn.promptStarted ? undefined : this.turn) : this.background;
    return target;
  }

  /** Extension notifications the agent sends beside session/update. None is
   * content, but each is proof of life, and some say something worth showing. */
  private extension(method: string, params: Json): void {
    if (method === '_auth/status_update') return this.authStatus(params);
    // `_claude/sdkMessage` (raw SDK frames, only the ones asked for in
    // ACP_SESSION_META) carries the background-task level; the rest and
    // `_claude/rateLimit` are activity only: the structured readings ride
    // session/update's _meta.
    const update = method === '_claude/sdkMessage' && params.message && typeof params.message === 'object'
      ? backgroundWork(params.message as Json) : undefined;
    if (update) return this.backgroundWorkChanged(params, update);
    const target = this.liveTarget(params);
    if (!target) return;
    if (method === '_session/goal') target.observer.onPhase?.('goal updated');
    else if (method === '_session/steering') target.observer.onPhase?.('message taken into the turn');
  }

  /** The vendor's level changed. Remembered whoever is listening; told to
   * the user's turn, or to the background turn -- opened for it when work
   * runs and nothing else is following (a terminal outliving its turn), and
   * ended when the level empties and no tool is left. */
  private backgroundWorkChanged(params: Json, update: BackgroundWork): void {
    const before = this.backgroundLevel;
    this.backgroundLevel = mergeBackgroundWork(before, update);
    let target = this.liveTarget(params);
    let opened = false;
    const expected = this.turn?.sessionId ?? this.sessionId;
    const ours = typeof params.sessionId !== 'string' || !expected || params.sessionId === expected;
    if (!target && ours && !this.turn && this.backgroundLevel && this.live) {
      target = this.openBackground('background-work');
      opened = Boolean(target);
    }
    // What a freshly opened run is told is the whole level.
    if (target) target.observer.onBackgroundWork?.(opened ? this.fullLevel() : update);
    const run = this.background;
    if (!run || run.channel.done) return;
    if (!this.backgroundLevel && target === run && this.pendingTools.size === 0) this.finishBackground('completed');
  }

  /** claude-agent-acp pushes the identity it runs as (`_auth/status_update`
   * {authStatus:{kind,label}}). `none` is a known sign-out -- "cannot
   * determine" is silence -- so the turn ends now with the sign-in path
   * rather than waiting for the vendor to fail the prompt itself. */
  private authStatus(params: Json): void {
    const status = params.authStatus;
    if (!status || typeof status !== 'object' || status.kind !== 'none') return;
    const turn = this.turn;
    if (!turn || turn.done) return;
    const command = turn.input.command;
    turn.fail(Object.assign(
      new Error(`${command} is not signed in${typeof status.label === 'string' && status.label ? ` (${status.label})` : ''}: sign in with \`${command} auth login\` or your account's sign-in`),
      { rpcCode: ACP_AUTH_REQUIRED_CODE, statusCode: 401, acpSignedOut: true },
    ));
  }

  /** Prompts open for the agent's requests, by JSON-RPC id: the agent
   * withdrawing one (`$/cancel_request`) closes the prompt on screen. */
  private readonly requestPrompts = new Map<string, () => void>();

  private withdrawn(requestId: unknown): void {
    if (typeof requestId === 'string' || typeof requestId === 'number') this.requestPrompts.get(String(requestId))?.();
  }

  /** Puts a question to the user through `stream`, with steering held while it
   * is open. Never answered for the user. */
  private async askUser(
    stream: Stream, turn: ActiveTurn | undefined, request: HarnessQuestionRequest, id: number | string | undefined, declined: string,
  ): Promise<HarnessQuestionResult> {
    if (turn) turn.approvals++;
    const prompt = this.openPrompt();
    if (id !== undefined) this.requestPrompts.set(String(id), prompt.abort);
    try {
      stream.observer.onPhase?.(`waiting for your answer: ${request.title}`);
      return await askHarnessQuestion(stream.observer, request, prompt.signal, declined);
    } finally {
      if (id !== undefined) this.requestPrompts.delete(String(id));
      prompt.release();
      if (turn) {
        turn.approvals--;
        this.steerPause(turn);
      }
    }
  }

  /** `elicitation/create`: a form (claude-agent-acp's AskUserQuestion, an MCP
   * server's input request). Answered `accept` with the form's content, or
   * `cancel`. A url-mode request is declined: it was not advertised. */
  private async elicitation(params: Json, id?: number | string): Promise<Json> {
    const turn = this.turn && !this.turn.done ? this.turn : undefined;
    const stream: Stream | undefined = turn ?? (this.turn ? undefined : this.background ?? this.openBackground());
    if (!stream) return { action: 'cancel' };
    if (params.mode && params.mode !== 'form') return { action: 'decline' };
    const agent = turn?.input.command ?? 'The agent';
    const form = formToQuestions(typeof params.message === 'string' ? params.message : '', params.requestedSchema, `${agent} asks`);
    if (!form) return { action: 'decline' };
    const result = await this.askUser(stream, turn, form.request, id, `${agent} asked a question and it was left unanswered: this screen cannot show it`);
    if (turn?.done || result.kind !== 'answered') return { action: 'cancel' };
    return { action: 'accept', content: form.content(result.answers) };
  }

  private async permission(params: Json, id?: number | string): Promise<Json> {
    const turn = this.turn && !this.turn.done ? this.turn : undefined;
    const cancelled = { outcome: { outcome: 'cancelled' } };
    // Out of turn the agent still asks -- through the background turn.
    const stream: Stream | undefined = turn ?? (this.turn ? undefined : this.background ?? this.openBackground());
    if (!stream) return cancelled;
    const command = turn?.input.command ?? 'The agent';
    const optionAnswer = (optionId: string): Json => turn?.done ? cancelled : { outcome: { outcome: 'selected', optionId } };
    // A question, not a tool: no permission mode may pick an answer for the
    // user. The user's pick is the answer; Skip only when they skip or there
    // is nothing to ask them with.
    const question = acpQuestionPermission(params);
    if (question && !stream.observer.onQuestion) {
      // Nothing can ask the user: skipped, and said so. Never an answer chosen for them.
      stream.observer.onNotice?.(`${command} asked "${question.prompt}"${question.answers.length ? ` (${question.answers.join(' / ')})` : ''} and it was skipped: this screen cannot show it`);
      return optionAnswer(question.skipOptionId);
    }
    if (question) {
      const result = await this.askUser(stream, turn, {
        title: `${command} asks`,
        questions: [{ id: 'answer', prompt: question.prompt, options: question.choices.map((choice) => ({ label: choice.name })), optional: true }],
      }, id, `${command} asked "${question.prompt}"${question.answers.length ? ` (${question.answers.join(' / ')})` : ''} and it was skipped: this screen cannot show it`);
      if (result.kind === 'cancelled') return cancelled;
      const picked = result.answers.answer?.[0];
      return optionAnswer(question.choices.find((choice) => choice.name === picked)?.optionId ?? question.skipOptionId);
    }
    // ExitPlanMode: the plan's way out is the user's to choose, in every mode.
    const exit = stream.observer.onQuestion ? acpPlanChoices(params) : undefined;
    if (exit) {
      const result = await this.askUser(stream, turn, {
        title: `${command} has a plan`,
        questions: [{ id: 'plan', header: 'Plan', prompt: exit.plan ?? String(params.toolCall?.title ?? 'Leave plan mode?'), options: exit.choices.map((choice) => ({ label: choice.name })) }],
      }, id, `${command} asked to leave plan mode and it was left unanswered: this screen cannot show it`);
      if (result.kind === 'cancelled') return cancelled;
      const picked = result.answers.plan?.[0];
      const choice = exit.choices.find((candidate) => candidate.name === picked);
      return choice ? optionAnswer(choice.optionId) : cancelled;
    }
    const readLive = turn?.input.currentPermissionMode;
      const liveMode = readLive ? await readLive().catch(() => undefined) : undefined; // fail-open-ok: the mode the turn started with still stands.
    const plan = acpPermissionPlan(liveMode ?? turn?.input.permissionMode ?? 'ask', params);
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
      // Nothing is steered in while the user is being asked.
      if (turn) turn.approvals++;
      const prompt = this.openPrompt();
      if (id !== undefined) this.requestPrompts.set(String(id), prompt.abort);
      try {
        stream.observer.onPhase?.(`waiting for your approval: ${title}`);
        const diff = acpActivityEvent({ ...params.toolCall, sessionUpdate: 'tool_call' })?.diff;
        accepted = plan.allowOptionId !== undefined && await stream.observer.onApproval?.(title, detail, diff?.length ? { diff } : undefined, prompt.signal, callId) === true;
      } finally {
        if (id !== undefined) this.requestPrompts.delete(String(id));
        prompt.release();
          if (turn) {
          turn.approvals--;
          this.steerPause(turn);
        }
      }
    }
    // Refused, it never runs; an agent that reports it failed settles it too.
    if (opened && !accepted && turn) {
      this.pendingTools.delete(callId!);
      if (this.pendingTools.size === 0) {
        this.steerPause(turn);
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
/** A load/resume of the wanted thread that the agent says does not exist. Claude Code's ACP
 * answers `Resource not found: <id>` (JSON-RPC -32002, the ACP "resource not found" code): its
 * own store lost the thread (chat de679bc3 failed six turns in a row on it, 2026-10-08, each
 * classified `other`). The thread is gone, not the account, so the turn starts a fresh one and
 * retells ClikCode's transcript (failover.ts `native-thread-invalid`). */
/** JSON-RPC -32000: ACP's "authentication required". */
const ACP_AUTH_REQUIRED_CODE = -32000;

export function markMissingThread(error: unknown, wanted: string): unknown {
  if (!(error instanceof Error)) return error;
  const code = (error as { rpcCode?: unknown }).rpcCode;
  const text = error.message;
  const notFound = code === -32002
    || (/not\s+found|does not exist|no such/i.test(text) && (text.includes(wanted) || /\b(session|thread|conversation|resource)\b/i.test(text)));
  return notFound ? Object.assign(error, { nativeThreadInvalid: true }) : error;
}

export function createAcpSession(options: PersistentSessionOptions = {}): AcpSession {
  return new AcpSessionImpl(options);
}

export function runAcpTurn(input: AcpTurnInput, options: PersistentSessionOptions = {}): Promise<AcpTurnResult> {
  return runOneTurn(createAcpSession(options), input);
}

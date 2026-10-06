/** Parsing a vendor's activity stream into ClikCode's own events: tool
 * starts and completions, thinking, and the capped previews of their
 * output that the UI is allowed to show. */

import { visibleSlice } from '../../tui/render/width.js';
import type { AiLocalHarnessDefinition } from '../definition.js';
import type { HarnessActivityEvent } from '../prompter.js';
import { claudeShaped, JsonRecord, opencodeShaped, asRecord } from './json-lines.js';
import { eventDiff, unifiedEventDiff } from '../../agent/line-diff.js';
import { categoryOf, formatToolRow, toolLabel } from './tools.js';

import { COMMAND_HEAD_LINES } from './activity-view.js';

/** Lines of tool output an event carries -- more than any row shows, so the
 * renderer can choose what to show (first lines, or a command's last), and
 * as many as a turn keeps of a call (turn/turn-activities.ts MAX_OUTPUT_LINES,
 * where the number is justified). */
export const EVENT_OUTPUT_LINES = 60;

/** What a harness appends to a command's output that the command never
 * printed: Claude Code's `Shell cwd was reset to <dir>` when the command
 * left its shell in another directory. Shown as the command's last line --
 * the one a row shows -- it filled a slot under nearly every command. */
const HARNESS_NOTE = /(?:^|\r?\n)Shell cwd was reset to [^\r\n]+\s*$/;

export function withoutHarnessNotes(text: string): string {
  return text.replace(HARNESS_NOTE, '');
}

/** A tool's output as an event carries it: at most EVENT_OUTPUT_LINES lines,
 * from the start or (`tail`) the end, with the count of what was dropped. */
export function activityOutput(text: string, options: { tail?: boolean } = {}): Pick<HarnessActivityEvent, 'output' | 'outputOmitted' | 'outputTail' | 'outputHead'> {
  const normalized = withoutHarnessNotes(text).replace(/\r?\n$/, '');
  if (!normalized.trim()) return {};
  const lines = normalized.split(/\r?\n/);
  const kept = options.tail ? lines.slice(-EVENT_OUTPUT_LINES) : lines.slice(0, EVENT_OUTPUT_LINES);
  const omitted = lines.length - kept.length;
  // A tail cut from a long output keeps its first lines too, for the row
  // that shows a command's head and tail (commandOutputPreview).
  return {
    output: kept, ...(omitted ? { outputOmitted: omitted } : {}), ...(options.tail ? { outputTail: true } : {}),
    ...(options.tail && omitted ? { outputHead: lines.slice(0, COMMAND_HEAD_LINES) } : {}),
  };
}

function cappedActivityOutput(text: string): Pick<HarnessActivityEvent, 'output' | 'outputOmitted' | 'outputTail'> {
  const normalized = withoutHarnessNotes(text).trim();
  if (!normalized) return {};
  // Machine-readable tool output belongs to the native event protocol, not
  // the human transcript. Printing JSON/JSONL here was the reason a working
  // turn looked like a wall of tool-call envelopes until the final response
  // replaced it. Keep the useful tool label/status and omit its raw payload.
  const records = normalized.split(/\r?\n/).filter(Boolean);
  const isJson = (candidate: string): boolean => {
    if (!/^(?:\{|\[)/.test(candidate.trim())) return false;
    try { JSON.parse(candidate); return true; } catch { return false; }
  };
  if (isJson(normalized) || (records.length > 0 && records.every(isJson))) return {};
  return activityOutput(normalized);
}

/** Exit code and duration of a finished command, under the names vendors
 * use for them. Absent fields are left out rather than guessed. */
export function commandOutcome(record: Record<string, unknown> | undefined): { exitCode?: number; durationMs?: number } {
  const exitCode = [record?.exitCode, record?.exit_code].find((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const durationMs = [record?.durationMs, record?.duration_ms].find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return { ...(exitCode !== undefined ? { exitCode } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
}

/** A file change (Codex's `fileChange`/`file_change`): the paths as the
 * row's label, and -- where the vendor sends the unified diff -- its lines. */
export function fileChangeActivity(changes: unknown): { label: string; category: 'edit'; diff?: HarnessActivityEvent['diff'] } {
  const list: JsonRecord[] = Array.isArray(changes) ? changes.map((change) => asRecord(change)).filter((change): change is JsonRecord => Boolean(change))
    : asRecord(changes) ? Object.entries(asRecord(changes)!).map(([file, change]): JsonRecord => ({ path: file, ...asRecord(change) })) : [];
  const paths = list.flatMap((change) => typeof change.path === 'string' && change.path ? [change.path] : []);
  const label = formatToolRow('edit', paths.length > 3 ? `${paths.slice(0, 3).join(', ')} +${paths.length - 3} more` : paths.join(', ') || 'files', 'edit');
  // Each file on its own, numbered from its hunks, with the kind of change
  // (Codex's add / delete / update / move) -- not one merged list.
  const parts = list.flatMap((change) => {
    const text = typeof change.diff === 'string' ? change.diff : typeof change.unified_diff === 'string' ? change.unified_diff : undefined;
    if (text === undefined) return [];
    const kind = String(asRecord(change.kind)?.type ?? change.kind ?? '');
    const changeKind = (['add', 'delete', 'update', 'move'] as const).find((value) => value === kind);
    return unifiedEventDiff(text, { ...(typeof change.path === 'string' ? { path: change.path } : {}), ...(changeKind ? { change: changeKind } : {}) });
  });
  return { label, category: 'edit', ...(parts.length ? { diff: parts } : {}) };
}

/** HarnessActivityEvent plus the id of the tool call that spawned it, when the
 * activity belongs to a subagent (Claude's `parent_tool_use_id`). Structurally
 * a HarnessActivityEvent, so it can be passed anywhere one is accepted. */
export type NativeActivityEvent = HarnessActivityEvent & { parentId?: string };

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    const record = asRecord(part);
    return typeof record?.text === 'string' ? [record.text] : [];
  }).join('\n');
}

/** A thought as one row shows it: whitespace folded, and the latest part of
 * a long one -- a thought streams, and its newest words are the ones that say
 * what the model is doing now. */
export function thoughtLabel(text: string): string {
  const folded = text.replace(/\s+/g, ' ').trim();
  return folded.length > THOUGHT_LABEL_CHARS ? `…${folded.slice(-(THOUGHT_LABEL_CHARS - 1))}` : folded;
}
const THOUGHT_LABEL_CHARS = 240;

/** The id a thought row of Claude message `messageId` goes by, streamed
 * (events/claude-stream.ts) or completed (below): the completed block
 * replaces the streamed thought rather than adding a second. */
export const claudeThinkingId = (messageId: string): string => `thinking:${messageId}`;

const first = (record: JsonRecord, keys: readonly string[]): string | undefined =>
  keys.map((key) => record[key]).find((value): value is string => typeof value === 'string');

/** The change an edit or write tool's own input describes, whatever the
 * harness calls its fields -- Claude's old_string/new_string, OpenCode's
 * oldString/newString, Amp's
 * old_str/new_str, Pi's oldText/newText, a write's content or file_text, a
 * multi-edit's `edits`. A replacement is a fragment of the file, so its
 * lines are not numbered; a write is the whole file, so they are. */
export function editDiffFromInput(input: JsonRecord | undefined): HarnessActivityEvent['diff'] {
  if (!input) return undefined;
  const path = first(input, ['file_path', 'path', 'filePath', 'target_file', 'filename', 'abs_path']);
  const at = path ? { path } : {};
  const replace = (record: JsonRecord) => {
    const before = first(record, ['old_string', 'oldString', 'old_str', 'oldText', 'old_text', 'search']);
    const after = first(record, ['new_string', 'newString', 'new_str', 'newText', 'new_text', 'replace']);
    return before !== undefined && after !== undefined ? eventDiff(before, after, at) : [];
  };
  const edits = Array.isArray(input.edits) ? input.edits.flatMap((edit) => (asRecord(edit) ? replace(asRecord(edit)!) : [])) : [];
  const diff = [...replace(input), ...edits];
  if (diff.length) return diff;
  const content = first(input, ['content', 'file_text', 'contents']);
  // A write's input is the new file only: whether it replaced something, and
  // what, the vendor does not say.
  return content !== undefined && path ? eventDiff('', content, { ...at, numbered: true, priorUnknown: true }) : undefined;
}

/** What every parser says about a tool call from its name and input: its
 * label, its kind of work, and -- for an edit -- the change. One place, so
 * a harness whose stream carries the input gets the same row as any other. */
export function toolFacts(name: string, input: JsonRecord | undefined, command: string): Pick<HarnessActivityEvent, 'label' | 'category' | 'agent' | 'diff' | 'call'> {
  const classified = categoryOf(name, input, command);
  const diff = classified.category === 'edit' ? editDiffFromInput(input) : undefined;
  return { label: toolLabel(name, input, classified.category), ...classified, ...(diff?.length ? { diff } : {}), call: toolCall(name, input) };
}

/** Characters one argument string keeps in a call record. */
const CALL_VALUE_CHARS = 2_000;
/** Serialized size of a call's arguments as kept. A Write's whole file, a
 * long patch: the diff already carries the change, bounded on its own. */
export const CALL_INPUT_MAX_CHARS = 4_096;

function clipValue(value: unknown, limit: number, depth = 0): unknown {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 3) return clipValue(JSON.stringify(value), limit);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => clipValue(item, limit, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, clipValue(item, limit, depth + 1)]));
}

/** A call's arguments within CALL_INPUT_MAX_CHARS: every string clipped,
 * then clipped harder, and past that only the argument names survive. */
export function boundCallInput(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  for (const limit of [CALL_VALUE_CHARS, 400, 80]) {
    const clipped = clipValue(input, limit) as Record<string, unknown>;
    if (JSON.stringify(clipped).length <= CALL_INPUT_MAX_CHARS) return clipped;
  }
  return Object.fromEntries(Object.keys(input).slice(0, 50).map((key) => [key, '…']));
}

/** The call itself, as the vendor made it, for `HarnessActivityEvent.call`. */
export function toolCall(name: string, input: Record<string, unknown> | undefined): NonNullable<HarnessActivityEvent['call']> {
  const bounded = boundCallInput(input);
  return { name, ...(bounded ? { input: bounded } : {}) };
}

/** One Claude-shaped `tool_use` block. */
export function claudeToolStart(tool: JsonRecord, command: string): NativeActivityEvent {
  return { kind: 'tool-start', ...toolFacts(String(tool.name ?? 'tool'), asRecord(tool.input), command), ...(typeof tool.id === 'string' ? { id: tool.id } : {}) };
}

/** Every activity one record describes. A single Claude message routinely
 * carries several parallel tool_use blocks (and the following user message all
 * of their tool_results); reporting only the first left the rest running
 * forever in the UI and unrecorded in the checkpoint. */
export function parseNativeActivityEventsFromValue(harness: AiLocalHarnessDefinition, parsed: unknown): NativeActivityEvent[] {
  const value = asRecord(parsed);
  if (!value) return [];
  if (claudeShaped(harness)) {
    const claude = claudeShapedActivity(value, harness.command);
    if (claude) return claude;
  }
  if (harness.parser === 'goose') {
    const goose = gooseActivity(value, harness.command);
    if (goose) return goose;
  }
  const single = singleActivityEvent(harness, value);
  return single ? [single] : [];
}

/** Claude Code stream-json (also Qwen Code). Returns undefined for records
 * this shape does not own, so the generic branches still get a look. */
function claudeShapedActivity(value: JsonRecord, command: string): NativeActivityEvent[] | undefined {
  const type = String(value.type ?? '');
  const parent = typeof value.parent_tool_use_id === 'string' && value.parent_tool_use_id ? { parentId: value.parent_tool_use_id } : {};
  // A block in flight is read by the turn's own stream state
  // (events/claude-stream.ts); a single record says nothing about it.
  if (type === 'system' || type === 'result' || type === 'rate_limit_event' || type === 'stream_event') return [];
  const message = asRecord(value.message);
  const content = message?.content;
  if (type === 'assistant') {
    if (!Array.isArray(content)) return [];
    const thoughtId = typeof message?.id === 'string' ? { id: claudeThinkingId(message.id) } : {};
    return content.flatMap((part): NativeActivityEvent[] => {
      const block = asRecord(part);
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use') return [{ ...claudeToolStart(block, command), ...parent }];
      if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        return [{ kind: 'thinking', label: thoughtLabel(block.thinking), ...thoughtId, ...parent }];
      }
      return [];
    });
  }
  if (type === 'user') {
    if (!Array.isArray(content)) return [];
    const results = content.filter((part) => asRecord(part)?.type === 'tool_result');
    // The record's own `tool_use_result` describes its (one) result: for a
    // sub-agent, what it spent in all.
    const totals = results.length === 1 ? subAgentTotals(asRecord(value.tool_use_result ?? value.toolUseResult)) : {};
    return results.flatMap((part): NativeActivityEvent[] => {
      const result = asRecord(part)!;
      const output = cappedActivityOutput(blockText(result.content));
      return [{
        kind: result.is_error === true ? 'tool-error' : 'tool-done', label: 'tool',
        ...(typeof result.tool_use_id === 'string' ? { id: result.tool_use_id } : {}),
        ...output, ...totals, ...parent,
      }];
    });
  }
  return undefined;
}

/** A Claude Code Task result's totals -- `totalToolUseCount`,
 * `totalTokens`, `totalDurationMs` -- as the parent row's tool uses, tokens
 * and run time. The vendor's count replaces the one the display kept by
 * counting the sub-agent's calls as they came. Nothing for any other result. */
export function subAgentTotals(result: JsonRecord | undefined): Pick<HarnessActivityEvent, 'childTools' | 'childTokens' | 'durationMs'> {
  const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
  const tools = count(result?.totalToolUseCount);
  const tokens = count(result?.totalTokens);
  const duration = count(result?.totalDurationMs);
  return {
    ...(tools !== undefined ? { childTools: tools } : {}),
    ...(tokens ? { childTokens: tokens } : {}),
    ...(duration !== undefined && (tools !== undefined || tokens !== undefined) ? { durationMs: duration } : {}),
  };
}

/** Goose stream-json: `{type:'message', message:{role, content:[...]}}` where
 * content parts are Goose's own Message serialization -- `toolRequest`
 * ({id, toolCall:{status, value:{name, arguments}}}) on assistant messages and
 * `toolResponse` ({id, toolResult:{status, value|error}}) on user messages. */
function gooseActivity(value: JsonRecord, command: string): NativeActivityEvent[] | undefined {
  if (value.type !== 'message') return undefined;
  const content = asRecord(value.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): NativeActivityEvent[] => {
    const block = asRecord(part);
    const identity = typeof block?.id === 'string' ? { id: block.id } : {};
    if (block?.type === 'toolRequest') {
      const call = asRecord(block.toolCall);
      const detail = asRecord(call?.value) ?? call;
      const name = String(detail?.name ?? 'tool');
      const args = asRecord(detail?.arguments);
      // Start and error read the same: `args` is in hand either way, and a
      // tool that FAILED is the one a reader most wants identified.
      const kind = call?.status === 'error' ? 'tool-error' as const : 'tool-start' as const;
      return [{ kind, ...toolFacts(name, args, command), ...identity }];
    }
    if (block?.type === 'toolResponse') {
      const result = asRecord(block.toolResult);
      const failed = result?.status === 'error' || result?.isError === true || asRecord(result?.value)?.isError === true;
      const payload = Array.isArray(result?.value) ? result.value : asRecord(result?.value)?.content;
      const output = cappedActivityOutput(blockText(payload));
      return [{ kind: failed ? 'tool-error' : 'tool-done', label: 'tool', ...identity, ...output }];
    }
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      return [{ kind: 'thinking', label: visibleSlice(block.thinking.trim().replace(/\s+/g, ' '), 140) }];
    }
    return [];
  });
}

/** Cursor CLI's stream-json (cursor-agent 2026.09.26): `tool_call` started /
 * completed records whose `tool_call` is the call's protobuf message, either
 * `{ tool: { case, value } }` or keyed by the case (`shellToolCall`,
 * `readToolCall`, `editToolCall`, …), with `value.args` and `value.result`
 * (`success` or `error`); and `thinking` deltas. They were all ignored, so
 * Cursor's CLI turns had no tool rows. */
function cursorActivity(value: JsonRecord): NativeActivityEvent | undefined {
  if (value.type === 'thinking' && typeof value.text === 'string' && value.text) return { kind: 'thinking', label: value.text };
  if (value.type !== 'tool_call') return undefined;
  const call = asRecord(value.tool_call);
  const tagged = asRecord(call?.tool);
  const [kind, body] = typeof tagged?.case === 'string' ? [tagged.case, asRecord(tagged.value)] : Object.entries(call ?? {}).map(([key, entry]) => [key, asRecord(entry)] as const)[0] ?? [];
  if (!kind) return undefined;
  const result = asRecord(body?.result);
  const success = asRecord(result?.success);
  const error = asRecord(result?.error) ?? asRecord(result?.failure);
  const text = [success?.stdout, success?.stderr, success?.output, success?.content, error?.stderr, error?.message, error?.error]
    .filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
  const exitCode = [success?.exitCode, error?.exitCode].find((code): code is number => typeof code === 'number');
  const done = value.subtype === 'completed';
  return {
    kind: done ? (error || (exitCode ?? 0) !== 0 ? 'tool-error' : 'tool-done') : 'tool-start',
    ...toolFacts(String(kind).replace(/ToolCall$/, ''), asRecord(body?.args), 'cursor'),
    ...(typeof value.call_id === 'string' ? { id: value.call_id } : {}),
    ...(done && text ? activityOutput(text, { tail: true }) : {}),
    ...(done && exitCode !== undefined ? { exitCode } : {}),
  };
}

function singleActivityEvent(harness: AiLocalHarnessDefinition, value: JsonRecord): NativeActivityEvent | undefined {
  const type = String(value.type ?? '');
  if (harness.parser === 'cursor-stream-json') return cursorActivity(value);
  if (harness.parser === 'antigravity' && value.event === 'step_update') {
    const step = value.step_update && typeof value.step_update === 'object' ? value.step_update as Record<string, unknown> : undefined;
    if (step?.step_type === 'tool') {
      const state = String(step.state ?? '');
      const name = String(step.tool_name ?? 'tool');
      // The parameters ARE on the stream, contrary to what tools.ts used to
      // say about this harness. Verified against agy 1.2.7: a tool step
      // carries tool_info.parameters, with CommandLine on run_command and
      // AbsolutePath on view_file. Reading only tool_name is what reduced
      // every tool row to a bare "run_command" with no sign of what ran --
      // and it also cost the classifier its best signal, since a command is
      // what tells a nameless tool apart from a read.
      const parameters = asRecord(asRecord(step.tool_info)?.parameters);
      // step_index is this harness's tool-call identity, and it is on every
      // update for the step. Without it an ACTIVE update and the DONE that
      // follows look like two unrelated events: the TUI appends a detached
      // completion instead of settling the row, and -- since a backgrounded
      // command is detected as a start with no matching completion -- a tool
      // that merely reported progress twice would be mistaken for one still
      // waiting. See turn/pending-work.ts.
      const stepIndex = step.step_index;
      return {
        kind: /error|fail/i.test(state) ? 'tool-error' : state === 'DONE' ? 'tool-done' : 'tool-start',
        ...toolFacts(name, parameters, harness.command),
        ...(typeof stepIndex === 'number' ? { id: `step-${stepIndex}` } : {}),
      };
    }
  }
  const item = value.item && typeof value.item === 'object' ? value.item as Record<string, unknown> : undefined;
  const itemType = String(item?.type ?? '');
  const reasoningSummary = (candidate: unknown): string | undefined => {
    if (typeof candidate === 'string') return candidate.trim() || undefined;
    if (!Array.isArray(candidate)) return undefined;
    const text = candidate.flatMap((part) => {
      if (typeof part === 'string') return [part];
      if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') return [String((part as Record<string, unknown>).text)];
      return [];
    }).join(' ').trim();
    return text || undefined;
  };
  if (type === 'thread.started' || type === 'turn.started') return undefined;
  if (/reasoning|thinking/.test(itemType) && /completed|done/.test(type)) {
    const summary = reasoningSummary(item?.summary) ?? reasoningSummary(item?.text) ?? reasoningSummary(item?.content);
    return summary ? { kind: 'thinking', label: visibleSlice(summary.replace(/\s+/g, ' '), 140) } : undefined;
  }
  if (/command_execution/.test(itemType) && /started|completed/.test(type)) {
    const command = String(item?.command ?? item?.command_line ?? '').trim();
    const startedId = typeof item?.id === 'string' ? item.id : undefined;
    // A `started` event often carries no command text yet. Dropping it meant
    // the tool was first recorded at its COMPLETION, which anchored the row
    // after everything the model said while the tool was running -- so that
    // prose rendered above the tool call that produced it. Emit the start
    // keyed by its id; the completion upserts the real label and output onto
    // this same row, at the position where the tool actually began.
    if (!command) {
      return type.endsWith('completed') || !startedId ? undefined
        : { kind: 'tool-start', label: 'tool', category: 'run', id: startedId };
    }
    const rawOutput = typeof item?.aggregated_output === 'string' ? item.aggregated_output
      : typeof item?.output === 'string' ? item.output : '';
    const output = cappedActivityOutput(rawOutput);
    const outcome = commandOutcome(item);
    return {
      kind: type.endsWith('completed')
        ? (item?.status === 'failed' || item?.status === 'error' || (outcome.exitCode ?? 0) !== 0 ? 'tool-error' : 'tool-done')
        : 'tool-start', label: formatToolRow('shell', command, 'run'), category: 'run',
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
      ...output,
      ...(type.endsWith('completed') ? outcome : {}),
    };
  }
  // A Codex collab call is a sub-agent the turn is waiting on. It matches
  // the generic tool_call pattern below, which would label it "tool" and
  // drop the fact that it is an agent.
  if (/collab_agent/.test(itemType) && /started|completed/.test(type)) {
    const name = String(item?.tool ?? item?.name ?? 'agent');
    const detail = typeof item?.prompt === 'string' ? item.prompt
      : typeof item?.task === 'string' ? item.task
        : typeof item?.description === 'string' ? item.description : undefined;
    return {
      kind: type.endsWith('completed')
        ? (item?.status === 'failed' || item?.status === 'error' ? 'tool-error' : 'tool-done')
        : 'tool-start', label: formatToolRow('agent', detail ?? name), agent: true,
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
    };
  }
  if (/file_change/.test(itemType) && /started|completed/.test(type)) {
    return {
      kind: type.endsWith('completed')
        ? (item?.status === 'failed' || item?.status === 'error' ? 'tool-error' : 'tool-done')
        : 'tool-start', ...fileChangeActivity(item?.changes),
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
    };
  }
  if (/mcp_tool_call|tool_use|tool_call/.test(itemType) && /started|completed/.test(type)) {
    const name = typeof item?.server === 'string' && typeof item?.tool === 'string' ? `mcp__${item.server}__${item.tool}` : String(item?.name ?? item?.server ?? 'tool');
    const args = asRecord(item?.arguments) ?? asRecord(item?.input);
    return {
      kind: type.endsWith('completed')
        ? (item?.status === 'failed' || item?.status === 'error' ? 'tool-error' : 'tool-done')
        : 'tool-start', ...toolFacts(name, args, harness.command),
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
    };
  }
  // opencode's own envelope is a different shape entirely: a top-level `type`
  // (not nested under `item`) and a `part` object instead of an `item` one.
  // Verified against a real `opencode run --format json` turn, including one
  // that actually called a tool — `part.tool` is the tool name and
  // `part.state.status` tracks completion.
  // Kilo Code CLI is an OpenCode fork and emits the same envelope.
  if (opencodeShaped(harness) && type === 'tool_use') {
    const part = asRecord(value.part);
    const state = asRecord(part?.state);
    const name = String(part?.tool ?? 'tool');
    const status = String(state?.status ?? '');
    const output = typeof state?.output === 'string' ? cappedActivityOutput(state.output) : {};
    return {
      kind: /error|fail/i.test(status) ? 'tool-error' : status === 'completed' ? 'tool-done' : 'tool-start',
      ...toolFacts(name, asRecord(state?.input), harness.command),
      ...(typeof part?.callID === 'string' ? { id: part.callID } : typeof part?.id === 'string' ? { id: part.id } : {}),
      ...output,
    };
  }
  // Command Code wraps each lifecycle event under a top-level
  // `{ type: 'event', event: {...} }` (distinct from its `{ type: 'result' }`
  // terminal frame). The event names and payloads below are read from the
  // published CLI itself (command-code 1.58 dist/cli.mjs): every tool emits
  // tool_running {toolCallId, toolName, description} and then exactly one of
  // tool_completed {toolCallId, toolName, result:[content blocks]} or
  // tool_errored {toolCallId, toolName, error}; a refused call emits
  // tool_denied / tool_hook_blocked instead of ever running.
  if (harness.command === 'command') {
    const inner = type === 'event' ? asRecord(value.event) : value;
    const innerType = String(inner?.type ?? '');
    const kind = innerType === 'tool_running' ? 'tool-start' as const
      : innerType === 'tool_completed' ? 'tool-done' as const
        : /^tool_(?:errored|denied|hook_blocked)$/.test(innerType) ? 'tool-error' as const : undefined;
    if (inner && kind) {
      const name = String(inner.toolName ?? 'tool');
      const description = typeof inner.description === 'string' ? inner.description.trim().split(/\r?\n/, 1)[0] : '';
      const rawOutput = innerType === 'tool_completed' ? blockText(inner.result) : typeof inner.error === 'string' ? inner.error : '';
      const output = cappedActivityOutput(rawOutput);
      const classified = categoryOf(name, undefined, harness.command);
      return {
        // Through the shared formatter, and on every kind -- this repeated
        // the format inline and showed the description only while running,
        // so the same tool changed shape the moment it finished.
        kind, label: formatToolRow(name, description, classified.category),
        ...classified,
        ...(typeof inner.toolCallId === 'string' ? { id: inner.toolCallId } : {}),
        ...output,
      };
    }
  }
  // Pi's own envelope (packages/coding-agent/docs/json.md):
  //   tool_execution_start / tool_execution_end -- a real pair, by
  //     `toolCallId`, so a row resolves the moment its call finishes.
  //   message_update -> assistantMessageEvent.toolcall_start -- the model
  //     choosing the tool; the call is `partial.content[contentIndex]`, with
  //     the same id the execution then reports.
  if (harness.parser === 'pi-json') {
    // With a toolCallId the pair settles by id, so the start can show its
    // arguments and the end, which carries none, keeps them. Without one the
    // turn's stream state gives each call an id of its own (adapters.ts), and
    // the label stays the same on both halves for any reader without one.
    const piTool = (record: JsonRecord, start: boolean): NativeActivityEvent => {
      const name = String(record.toolName ?? 'tool');
      const id = typeof record.toolCallId === 'string' && record.toolCallId ? record.toolCallId : undefined;
      const args = asRecord(record.args);
      const facts = toolFacts(name, args, harness.command);
      const label = !id ? formatToolRow(name, undefined, facts.category) : start || args ? facts.label : 'tool';
      return { kind: 'tool-start', ...facts, label, ...(id ? { id } : {}) };
    };
    if (type === 'tool_execution_start') return piTool(value, true);
    if (type === 'tool_execution_end') return { ...piTool(value, false), kind: value.isError === true || value.error ? 'tool-error' : 'tool-done' };
    const event = type === 'message_update' ? asRecord(value.assistantMessageEvent) : undefined;
    if (event?.type === 'toolcall_start') {
      const content = asRecord(event.partial)?.content;
      const call = Array.isArray(content) && typeof event.contentIndex === 'number' ? asRecord(content[event.contentIndex]) : undefined;
      return piTool(call ? { toolCallId: call.id, toolName: call.name, args: call.arguments } : event, true);
    }
  }
  return undefined;
}

/** The one place that decides what a completed/in-progress tool call or a
 * thinking summary looks like in the persistent activity log -- every
 * harness's parser above feeds this same renderer, so the visual language
 * (glyph, color, wording) never drifts per-vendor. */

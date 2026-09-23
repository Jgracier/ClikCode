/** Parsing a vendor's activity stream into ClikCode's own events: tool
 * starts and completions, thinking, and the capped previews of their
 * output that the UI is allowed to show. */

import { visibleSlice } from '../../tui/render/width.js';
import type { AiLocalHarnessDefinition } from '../definition.js';
import type { HarnessActivityEvent, ToolCategory } from '../prompter.js';
import { claudeShaped, JsonRecord, opencodeShaped, asRecord } from './json-lines.js';
import { categoryOf, formatToolRow, toolCategory, toolLabel } from './tools.js';

/** Line-capped, not byte-capped: a diff that's still readable at a glance
 * beats a byte-perfect one that pushes everything else out of the 5-line
 * activity window. */
/** Captured per side, so a balanced preview always has something to show from
 * both halves of an edit. */
const DIFF_CAPTURE_LINES = 8;

/** How much of a tool's work a transcript row shows. Enough to recognise the
 * edit or command at a glance without the trail crowding out the answer. */
export const ACTIVITY_PREVIEW_LINES = 8;

/** Preview budget per kind of work, because one number cannot fit all of it.
 *
 * Eight lines is right for a diff -- the edit IS the lines -- and far too
 * generous for everything else. A read's row already names the file, so its
 * output repeats what the label said; a command's first lines are the ones
 * that matter and the rest is scroll. At 8 for everything, three tool calls
 * filled half a phone screen and the answer they were serving fell off the
 * bottom. */
export const CATEGORY_PREVIEW_LINES: Readonly<Record<ToolCategory, number>> = {
  edit: ACTIVITY_PREVIEW_LINES,
  run: 3,
  search: 3,
  fetch: 2,
  read: 0,
};

/** Lines a settled tool row may show, given what kind of work it was. */
export function previewLinesFor(category?: ToolCategory): number {
  return category ? CATEGORY_PREVIEW_LINES[category] : ACTIVITY_PREVIEW_LINES;
}

function capDiffLines(text: string, max: number): { lines: string[]; truncated: number } {
  const all = text.split(/\r?\n/);
  return { lines: all.slice(0, max), truncated: Math.max(0, all.length - max) };
}

function cappedActivityOutput(text: string): string[] | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  // Machine-readable tool output belongs to the native event protocol, not
  // the human transcript. Printing JSON/JSONL here was the reason a working
  // turn looked like a wall of tool-call envelopes until the final response
  // replaced it. Keep the useful tool label/status and omit its raw payload.
  const records = normalized.split(/\r?\n/).filter(Boolean);
  const isJson = (candidate: string): boolean => {
    if (!/^(?:\{|\[)/.test(candidate.trim())) return false;
    try { JSON.parse(candidate); return true; } catch { return false; }
  };
  if (isJson(normalized) || (records.length > 0 && records.every(isJson))) return undefined;
  const capped = capDiffLines(normalized, 3);
  return [...capped.lines, ...(capped.truncated ? [`… ${capped.truncated} more line${capped.truncated === 1 ? '' : 's'}`] : [])];
}

/** HarnessActivityEvent plus the id of the tool call that spawned it, when the
 * activity belongs to a subagent (Claude's `parent_tool_use_id`). Structurally
 * a HarnessActivityEvent, so it can be passed anywhere one is accepted. */
export type NativeActivityEvent = HarnessActivityEvent & { parentId?: string };

const truncationNote = (count: number): string[] => count ? [`… ${count} more line${count === 1 ? '' : 's'}`] : [];

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    const record = asRecord(part);
    return typeof record?.text === 'string' ? [record.text] : [];
  }).join('\n');
}

/** One Claude-shaped `tool_use` block. */
function claudeToolStart(tool: JsonRecord, command: string): NativeActivityEvent {
  const name = String(tool.name ?? 'tool');
  const input = asRecord(tool.input);
  const identity = typeof tool.id === 'string' ? { id: tool.id } : {};
  // Verified against a real session transcript: Edit's input carries
  // old_string/new_string verbatim, Write carries the full new file as
  // `content` with no prior text to diff against.
  if (name === 'Edit' && typeof input?.old_string === 'string' && typeof input?.new_string === 'string') {
    const removed = capDiffLines(input.old_string, DIFF_CAPTURE_LINES);
    const added = capDiffLines(input.new_string, DIFF_CAPTURE_LINES);
    return {
      kind: 'tool-start', label: toolLabel(name, input), category: toolCategory(name, input, true), ...identity,
      diff: { removed: [...removed.lines, ...truncationNote(removed.truncated)], added: [...added.lines, ...truncationNote(added.truncated)] },
    };
  }
  if (name === 'Write' && typeof input?.content === 'string') {
    const added = capDiffLines(input.content, DIFF_CAPTURE_LINES);
    return {
      kind: 'tool-start', label: toolLabel(name, input), category: toolCategory(name, input, true), ...identity,
      diff: { removed: [], added: [...added.lines, ...truncationNote(added.truncated)] },
    };
  }
  return { kind: 'tool-start', label: toolLabel(name, input), ...categoryOf(name, input, command), ...identity };
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
  if (harness.command === 'goose') {
    const goose = gooseActivity(value, harness.command);
    if (goose) return goose;
  }
  const single = singleActivityEvent(harness, value);
  return single ? [single] : [];
}

function parseNativeActivityEvents(harness: AiLocalHarnessDefinition, lineText: string): NativeActivityEvent[] {
  const candidate = lineText.trim();
  if (candidate[0] !== '{') return [];
  try {
    return parseNativeActivityEventsFromValue(harness, JSON.parse(candidate));
  } catch {
    // fail-open-ok: plain-text harness output has no structured activity metadata to parse.
    return [];
  }
}

/** First activity on the line. Prefer parseNativeActivityEvents: a line can
 * describe several. */
export function parseNativeActivityEvent(harness: AiLocalHarnessDefinition, lineText: string): NativeActivityEvent | undefined {
  return parseNativeActivityEvents(harness, lineText)[0];
}

/** Claude Code stream-json (also Qwen Code). Returns undefined for records
 * this shape does not own, so the generic branches still get a look. */
function claudeShapedActivity(value: JsonRecord, command: string): NativeActivityEvent[] | undefined {
  const type = String(value.type ?? '');
  const parent = typeof value.parent_tool_use_id === 'string' && value.parent_tool_use_id ? { parentId: value.parent_tool_use_id } : {};
  if (type === 'system' || type === 'result' || type === 'rate_limit_event') return [];
  if (type === 'stream_event') {
    // The completed block (below) carries the thinking text; the block START is
    // what tells the UI the model has gone quiet because it is thinking.
    const event = asRecord(value.event);
    const block = asRecord(event?.content_block);
    return event?.type === 'content_block_start' && (block?.type === 'thinking' || block?.type === 'redacted_thinking')
      ? [{ kind: 'thinking', label: 'thinking', ...parent }] : [];
  }
  const content = asRecord(value.message)?.content;
  if (type === 'assistant') {
    if (!Array.isArray(content)) return [];
    return content.flatMap((part): NativeActivityEvent[] => {
      const block = asRecord(part);
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use') return [{ ...claudeToolStart(block, command), ...parent }];
      if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        return [{ kind: 'thinking', label: visibleSlice(block.thinking.trim().replace(/\s+/g, ' '), 140), ...parent }];
      }
      return [];
    });
  }
  if (type === 'user') {
    if (!Array.isArray(content)) return [];
    return content.flatMap((part): NativeActivityEvent[] => {
      const result = asRecord(part);
      if (result?.type !== 'tool_result') return [];
      const output = cappedActivityOutput(blockText(result.content));
      return [{
        kind: result.is_error === true ? 'tool-error' : 'tool-done', label: 'tool',
        ...(typeof result.tool_use_id === 'string' ? { id: result.tool_use_id } : {}),
        ...(output?.length ? { output } : {}), ...parent,
      }];
    });
  }
  return undefined;
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
      return [{ kind, label: toolLabel(name, args), ...categoryOf(name, args, command), ...identity }];
    }
    if (block?.type === 'toolResponse') {
      const result = asRecord(block.toolResult);
      const failed = result?.status === 'error' || result?.isError === true || asRecord(result?.value)?.isError === true;
      const payload = Array.isArray(result?.value) ? result.value : asRecord(result?.value)?.content;
      const output = cappedActivityOutput(blockText(payload));
      return [{ kind: failed ? 'tool-error' : 'tool-done', label: 'tool', ...identity, ...(output?.length ? { output } : {}) }];
    }
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      return [{ kind: 'thinking', label: visibleSlice(block.thinking.trim().replace(/\s+/g, ' '), 140) }];
    }
    return [];
  });
}

function singleActivityEvent(harness: AiLocalHarnessDefinition, value: JsonRecord): NativeActivityEvent | undefined {
  const type = String(value.type ?? '');
  if (harness.command === 'antigravity' && value.event === 'step_update') {
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
        label: toolLabel(name, parameters),
        ...(typeof stepIndex === 'number' ? { id: `step-${stepIndex}` } : {}),
        ...categoryOf(name, parameters, harness.command),
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
    return {
      kind: type.endsWith('completed')
        ? (item?.status === 'failed' || item?.status === 'error'
          || (typeof item?.exit_code === 'number' && item.exit_code !== 0)
          || (typeof item?.exitCode === 'number' && item.exitCode !== 0) ? 'tool-error' : 'tool-done')
        : 'tool-start', label: command,
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
      ...(output?.length ? { output } : {}),
    };
  }
  if (/file_change/.test(itemType) && /started|completed/.test(type)) {
    return {
      kind: type.endsWith('completed')
        ? (item?.status === 'failed' || item?.status === 'error' ? 'tool-error' : 'tool-done')
        : 'tool-start', label: 'files updated',
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
    };
  }
  if (/mcp_tool_call|tool_use|tool_call/.test(itemType) && /started|completed/.test(type)) {
    const name = String(item?.name ?? item?.server ?? 'tool');
    return {
      kind: type.endsWith('completed')
        ? (item?.status === 'failed' || item?.status === 'error' ? 'tool-error' : 'tool-done')
        : 'tool-start', label: name, ...categoryOf(name, undefined, harness.command),
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
    const output = typeof state?.output === 'string' ? cappedActivityOutput(state.output) : undefined;
    return {
      kind: /error|fail/i.test(status) ? 'tool-error' : status === 'completed' ? 'tool-done' : 'tool-start',
      label: toolLabel(name, asRecord(state?.input)), ...categoryOf(name, asRecord(state?.input), harness.command),
      ...(typeof part?.callID === 'string' ? { id: part.callID } : typeof part?.id === 'string' ? { id: part.id } : {}),
      ...(output?.length ? { output } : {}),
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
      return {
        // Through the shared formatter, and on every kind -- this repeated
        // the format inline and showed the description only while running,
        // so the same tool changed shape the moment it finished.
        kind, label: formatToolRow(name, description),
        ...categoryOf(name, undefined, harness.command),
        ...(typeof inner.toolCallId === 'string' ? { id: inner.toolCallId } : {}),
        ...(output?.length ? { output } : {}),
      };
    }
  }
  // Pi's own envelope. Two shapes, and only one of them pairs:
  //   tool_execution_start / tool_execution_end   -- a real pair, so a tool
  //     row resolves the moment it finishes, like every other harness.
  //   message_update -> assistantMessageEvent.toolcall_start  -- verified
  //     from its own docs (packages/coding-agent/docs/json.md), which name
  //     no paired completion, so a row started this way is only settled by
  //     the end of the turn (TurnTranscript's `tool.done || turnEnded`).
  //
  // The note here used to add "same as Command Code above", which is no
  // longer true: that harness maps tool_completed and
  // tool_errored/denied/hook_blocked, so it resolves its rows normally.
  if (harness.command === 'pi') {
    if (type === 'tool_execution_start') {
      return { kind: 'tool-start', label: String(value.toolName ?? 'tool'), ...categoryOf(String(value.toolName ?? 'tool'), undefined, harness.command) };
    }
    if (type === 'tool_execution_end') return {
      kind: value.isError === true || value.error ? 'tool-error' : 'tool-done',
      label: String(value.toolName ?? 'tool'),
    };
    if (type === 'message_update') {
      const event = value.assistantMessageEvent && typeof value.assistantMessageEvent === 'object'
        ? value.assistantMessageEvent as Record<string, unknown> : undefined;
      if (event?.type === 'toolcall_start') {
        return { kind: 'tool-start', label: String(event.toolName ?? 'tool'), ...categoryOf(String(event.toolName ?? 'tool'), undefined, harness.command) };
      }
    }
  }
  return undefined;
}

/** The one place that decides what a completed/in-progress tool call or a
 * thinking summary looks like in the persistent activity log -- every
 * harness's parser above feeds this same renderer, so the visual language
 * (glyph, color, wording) never drifts per-vendor. */

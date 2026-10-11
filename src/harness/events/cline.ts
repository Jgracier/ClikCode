/** Cline's `--json` stream as activity: one ClineMessage per line --
 * `{type: 'say'|'ask', say|ask: <kind>, text, ts, partial}`.
 *
 * Cline publishes no completion record for a call: a `tool`, `command` or
 * `use_mcp_server` message says what it is running, `command_output` /
 * `mcp_server_response` carry what it printed, and the call is over when the
 * next message of the conversation arrives (Cline runs them one at a time).
 * So a call is started on its first message (a partial and its final share a
 * `ts`, which is the id), fed by its output, and settled by the next message
 * that is not its own; an `error` says it failed. A call still open when the
 * stream ends is left to the turn, which closes it stopped.
 *
 * Only what the stream carries: no diff (Cline sends a patch string in its
 * own search/replace format), no usage here (the ACP session file has it). */

import { activityOutput, claudeThinkingId, thoughtLabel, toolFacts, type NativeActivityEvent } from '../protocol/activity-events.js';
import { asRecord, parseJsonRecord, type JsonRecord } from '../protocol/json-lines.js';
import type { StreamState } from './adapters.js';

/** The call a message is about, and the message that started it. */
interface OpenCall { id: string; ts: unknown; label: string; category?: NativeActivityEvent['category']; output: string }

/** Cline's tool names -> the verbs every harness's rows use. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  readFile: 'Read', editedExistingFile: 'Edit', newFileCreated: 'Write', fileDeleted: 'Delete',
  listFilesTopLevel: 'List', listFilesRecursive: 'List', listCodeDefinitionNames: 'List',
  searchFiles: 'Grep', webFetch: 'WebFetch',
};

const KINDS_THAT_CALL = new Set(['tool', 'command', 'use_mcp_server']);
const KINDS_THAT_CONTINUE = new Set(['command_output', 'mcp_server_response']);
/** Said as the answer (`replace`: a message is updated in place). */
export const CLINE_ANSWER_KINDS = new Set(['text', 'completion_result']);

export interface ClineState { open?: OpenCall; calls: number }

function startOf(kind: string, ts: unknown, text: string, state: ClineState, command: string): { id: string; facts: ReturnType<typeof toolFacts> } | undefined {
  const id = `cline-${typeof ts === 'number' || typeof ts === 'string' ? ts : ++state.calls}`;
  if (kind === 'command') return { id, facts: toolFacts('shell', { command: text }, command) };
  const payload = parseJsonRecord(text);
  if (!payload) return undefined;
  if (kind === 'use_mcp_server') {
    const args = typeof payload.arguments === 'string' ? parseJsonRecord(payload.arguments) : asRecord(payload.arguments);
    return { id, facts: toolFacts(`mcp__${String(payload.serverName ?? 'mcp')}__${String(payload.toolName ?? 'tool')}`, args, command) };
  }
  const name = TOOL_NAMES[String(payload.tool ?? '')] ?? String(payload.tool ?? 'tool');
  const { regex, content, ...rest } = payload as JsonRecord;
  return { id, facts: toolFacts(name, { ...rest, ...(typeof regex === 'string' ? { pattern: regex } : {}), ...(typeof content === 'string' && name === 'Write' ? { content } : {}) }, command) };
}

/** The call's last frame: what it printed (its tail), or the error that ended it. */
function settled(open: OpenCall, kind: 'tool-done' | 'tool-error', failure?: string): NativeActivityEvent {
  const said = failure?.trim() ? failure : open.output;
  return { kind, label: open.label, id: open.id, ...(open.category ? { category: open.category } : {}), ...(said.trim() ? activityOutput(said, { tail: true }) : {}) };
}

/** The activity one record of Cline's stream describes. */
export function clineLine(value: JsonRecord, turn: StreamState, command: string): NativeActivityEvent[] {
  const state = (turn.cline ??= { calls: 0 });
  const kind = String(value.say ?? value.ask ?? '');
  if (value.type !== 'say' && value.type !== 'ask') return [];
  const text = typeof value.text === 'string' ? value.text : '';
  const events: NativeActivityEvent[] = [];
  const open = state.open;
  const sameMessage = open !== undefined && open.ts === value.ts;
  const continues = open !== undefined && KINDS_THAT_CONTINUE.has(kind);

  // What the open call printed: another frame of the same row.
  if (open && continues) {
    if (text.trim()) {
      open.output = `${open.output}${open.output ? '\n' : ''}${text}`;
      events.push({ kind: 'tool-start', label: open.label, id: open.id, ...(open.category ? { category: open.category } : {}), ...activityOutput(text, { tail: true }) });
    }
    if (kind === 'mcp_server_response') { events.push(settled(open, 'tool-done')); state.open = undefined; }
    return events;
  }
  // Any other message of the conversation ends the call before it.
  if (open && !sameMessage && kind !== 'api_req_started') {
    events.push(settled(open, kind === 'error' ? 'tool-error' : 'tool-done', kind === 'error' ? text : undefined));
    state.open = undefined;
  }
  if (kind === 'reasoning' && text.trim()) {
    events.push({ kind: 'thinking', label: thoughtLabel(text), id: claudeThinkingId(`cline-${String(value.ts ?? '')}`) });
  } else if (KINDS_THAT_CALL.has(kind) && !(open && sameMessage)) {
    const started = startOf(kind, value.ts, text, state, command);
    if (started) {
      const { facts } = started;
      state.open = { id: started.id, ts: value.ts, label: facts.label, output: '', ...(facts.category ? { category: facts.category } : {}) };
      events.push({ kind: 'tool-start', ...facts, id: started.id });
    }
  }
  return events;
}

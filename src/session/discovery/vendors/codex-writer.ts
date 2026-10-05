/** Codex: a conversation written as Codex's own thread (NativeThreadWriter).
 *
 * The layout is the one codex-cli 0.155.1 writes itself, read from real
 * rollouts: `<CODEX_HOME>/sessions/<y>/<m>/<d>/rollout-<local time>-<id>.jsonl`
 * (local date and time, as Codex names them), one JSON record per line, each
 * `{ timestamp, ordinal, type, payload }`:
 *
 * - `session_meta` first: the thread id (a UUIDv7), cwd, cli_version.
 * - per turn: `task_started`, the request as a `response_item` user message,
 *   the answer's text as assistant messages (`commentary`, the last one
 *   `final_answer`) and its calls, then `task_complete` (`turn_aborted` for
 *   an interrupted last turn). The `response_item`s are what the model is
 *   given; the `event_msg item_completed` beside each (UserMessage,
 *   AgentMessage, CommandExecution, FileChange) are what Codex's own history
 *   (app-server `thread/resume` turns, the thread's title) is projected from.
 *
 * Calls are written as Codex 0.155.1 makes them: its models call one
 * `exec` custom tool whose input is a script calling `tools.exec_command`
 * or `tools.apply_patch`. So a Claude `Bash` becomes an exec_command, an
 * `Edit`/`Write` an apply_patch, a `Read`/`Grep`/`Glob` the shell command
 * Codex would have run for it; anything else (MCP, fetch, a sub-agent) stays
 * a plain function call under its own name, which Codex accepts. No
 * reasoning is written: Codex's is encrypted and cannot be forged.
 *
 * Indexes, verified live on 0.155.1 (app-server `thread/resume` and `codex
 * exec resume` both recalled the history, foreign Bash/Edit calls included):
 * - `state_5.sqlite` `threads` is trusted over the disk, but a thread with no
 *   row is found by Codex's scan and given one, titled from the first
 *   UserMessage. The id here is new, so no row can be stale; reconcile runs
 *   anyway, the same check a carry makes. Not written here.
 * - `thread_history_1.sqlite` (the UI history: thread/read, thread/resume
 *   turns) is Codex's own projection of the rollout's item_completed events,
 *   built on first open -- but only for a `history_mode: "paginated"` thread
 *   (what 0.155.1 writes itself). Without it the thread is "legacy" and its
 *   synthesized turns come back with no items. Not written here either: a
 *   projection row ClikCode wrote would be a second source for the same
 *   items, and Codex keeps its own offsets into the file. */

import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall, CanonicalTurn } from '../../canonical.js';
import { atomicWriteFile } from '../../store/files.js';
import type { NativeThreadWriteContext, NativeThreadWriter, NativeThreadWritten } from '../stores.js';
import { reconcileCodexThreadRow } from './codex-store.js';

/** Builds whose rollout layout this writer was checked against, live. */
export const CODEX_WRITER_TESTED_VERSIONS = ['codex-cli 0.155.1'] as const;

/** A UUIDv7 (RFC 9562): Codex's own thread and turn ids are these, and it
 *  orders by them. */
export function uuidv7(ms: number = Date.now()): string {
  const bytes = randomBytes(16);
  const time = BigInt(Math.max(0, Math.floor(ms)));
  for (let index = 0; index < 6; index += 1) bytes[index] = Number((time >> BigInt(8 * (5 - index))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Json = Record<string, unknown>;

/** What a write needs besides the record; fixed in tests for golden output. */
export interface CodexRolloutOptions {
  threadId: string;
  workspace: string;
  cliVersion: string;
  /** Epoch ms of the first record; each later one is a millisecond on. */
  startMs: number;
  /** Makes the turn/item ids; uuidv7 by default. */
  id?: (ms: number) => string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `sessions/<y>/<m>/<d>/rollout-<y>-<m>-<d>T<h>-<m>-<s>-<id>.jsonl`, in local
 *  time, as Codex names its own. */
export function codexRolloutRelativePath(threadId: string, ms: number): string {
  const at = new Date(ms);
  const day = [String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate())];
  const time = `${day.join('-')}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  return join('sessions', ...day, `rollout-${time}-${threadId}.jsonl`);
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join(' ');
  return undefined;
}

function shellQuote(value: string): string {
  return /^[\w./@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function absolute(path: string, workspace: string): string {
  return isAbsolute(path) ? path : resolve(workspace, path);
}

function patchLines(prefix: '+' | '-', body: string): string[] {
  const lines = body.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.map((line) => `${prefix}${line}`);
}

/** The call as Codex would have made it. */
type CodexCall =
  | { kind: 'command'; cmd: string }
  | { kind: 'patch'; patch: string; changes: Record<string, { type: 'add' | 'update' | 'delete'; unified_diff: string }> }
  | { kind: 'function'; name: string; arguments: string };

const COMMAND_TOOLS = new Set(['bash', 'shell', 'exec_command', 'run_shell_command', 'run_terminal_cmd', 'terminal', 'execute', 'command']);

function commandOf(call: CanonicalToolCall): string | undefined {
  const input = call.input ?? {};
  const given = text(input.command) ?? text(input.cmd);
  if (given?.trim()) return given;
  return call.category === 'run' || COMMAND_TOOLS.has(call.name.toLowerCase()) ? call.target : undefined;
}

function patchOf(call: CanonicalToolCall, workspace: string): Extract<CodexCall, { kind: 'patch' }> | undefined {
  const input = call.input ?? {};
  const raw = typeof input.input === 'string' ? input.input : typeof input.patch === 'string' ? input.patch : undefined;
  if (raw?.includes('*** Begin Patch')) {
    const changes: Record<string, { type: 'add' | 'update' | 'delete'; unified_diff: string }> = {};
    for (const match of raw.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
      changes[absolute(match[2]!.trim(), workspace)] = { type: match[1]!.toLowerCase() as 'add' | 'update' | 'delete', unified_diff: '' };
    }
    return { kind: 'patch', patch: raw, changes };
  }
  const file = text(input.file_path) ?? text(input.path) ?? text(input.filePath);
  const edits = Array.isArray(input.edits) ? input.edits as Json[] : [input];
  const hunks = edits.flatMap((edit) => {
    const before = text(edit.old_string) ?? text(edit.oldString) ?? text(edit.old_str);
    const after = text(edit.new_string) ?? text(edit.newString) ?? text(edit.new_str);
    return before !== undefined && after !== undefined ? [['@@', ...patchLines('-', before), ...patchLines('+', after)].join('\n')] : [];
  });
  if (file && hunks.length) {
    const path = absolute(file, workspace);
    const body = hunks.join('\n');
    return { kind: 'patch', patch: `*** Begin Patch\n*** Update File: ${path}\n${body}\n*** End Patch`, changes: { [path]: { type: 'update', unified_diff: body } } };
  }
  const content = text(input.content) ?? text(input.file_text);
  if (file && content !== undefined) {
    const path = absolute(file, workspace);
    const body = patchLines('+', content).join('\n');
    return { kind: 'patch', patch: `*** Begin Patch\n*** Add File: ${path}\n${body}\n*** End Patch`, changes: { [path]: { type: 'add', unified_diff: `@@\n${body}` } } };
  }
  // Recorded with only the change ClikCode drew (no arguments kept).
  const diffs = (call.diff ?? []).filter((diff) => diff.path && diff.lines.length);
  if (!diffs.length) return undefined;
  const changes: Record<string, { type: 'add' | 'update' | 'delete'; unified_diff: string }> = {};
  const sections = diffs.map((diff) => {
    const path = absolute(diff.path!, workspace);
    const body = diff.lines.map((line) => (line.kind === 'gap' ? '@@' : `${line.kind === 'removed' ? '-' : line.kind === 'added' ? '+' : ' '}${line.text}`)).join('\n');
    const type = diff.change === 'add' ? 'add' : diff.change === 'delete' ? 'delete' : 'update';
    changes[path] = { type, unified_diff: body };
    return type === 'add' ? `*** Add File: ${path}\n${body}` : type === 'delete' ? `*** Delete File: ${path}` : `*** Update File: ${path}\n${body.startsWith('@@') ? body : `@@\n${body}`}`;
  });
  return { kind: 'patch', patch: `*** Begin Patch\n${sections.join('\n')}\n*** End Patch`, changes };
}

/** Maps a recorded call, whoever made it, to the call Codex makes for it. */
export function codexCallFor(call: CanonicalToolCall, workspace: string): CodexCall {
  const name = call.name.toLowerCase();
  const input = call.input ?? {};
  if (call.category === 'edit' || ['edit', 'multiedit', 'write', 'apply_patch', 'str_replace_based_edit_tool', 'write_file', 'replace'].includes(name)) {
    const patch = patchOf(call, workspace);
    if (patch) return patch;
  }
  const command = commandOf(call);
  if (command) return { kind: 'command', cmd: command };
  const file = text(input.file_path) ?? text(input.path) ?? (name === 'read' ? call.target : undefined);
  if ((name === 'read' || name === 'read_file') && file) return { kind: 'command', cmd: `cat ${shellQuote(file)}` };
  const pattern = text(input.pattern) ?? text(input.query);
  if ((name === 'grep' || name === 'search') && pattern) {
    return { kind: 'command', cmd: `rg -n ${shellQuote(pattern)}${file ? ` ${shellQuote(file)}` : ''}` };
  }
  if (name === 'glob' && pattern) return { kind: 'command', cmd: `rg --files -g ${shellQuote(pattern)}${file ? ` ${shellQuote(file)}` : ''}` };
  const args = call.input ?? (call.target ? { target: call.target } : {});
  return { kind: 'function', name: call.name.replace(/[^\w-]/g, '_').slice(0, 64) || 'tool', arguments: JSON.stringify(args) };
}

function outputText(call: CanonicalToolCall): string {
  if (call.status === 'unfinished') return 'aborted: the turn ended before this call finished';
  const lines = call.output ?? [];
  const omitted = call.outputOmitted ? `[${call.outputOmitted} lines omitted]` : '';
  const body = [...(omitted && call.outputTail ? [omitted] : []), ...lines, ...(omitted && !call.outputTail ? [omitted] : [])].join('\n');
  const exit = call.exitCode !== undefined && call.exitCode !== 0 ? `${body ? '\n' : ''}Process exited with code ${call.exitCode}` : '';
  return `${body}${exit}` || (call.status === 'failed' ? 'failed' : '');
}

/** Codex's code-mode script result: a header part, then the output part. */
function scriptOutput(body: string): Json[] {
  return [{ type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' }, { type: 'input_text', text: body }];
}

/** The rollout's records, in order. Pure: everything time- or id-dependent
 *  comes from `options`. */
export function codexRolloutRecords(record: CanonicalRecord, options: CodexRolloutOptions): Json[] {
  const makeId = options.id ?? uuidv7;
  const { threadId, workspace } = options;
  const records: Json[] = [];
  let ms = options.startMs;
  const push = (type: string, payload: Json): void => {
    records.push({ timestamp: new Date(ms).toISOString(), ordinal: records.length, type, payload });
    ms += 1;
  };
  const completed = (turnId: string, item: Json): void => {
    push('event_msg', { type: 'item_completed', thread_id: threadId, turn_id: turnId, item, started_at_ms: ms, completed_at_ms: ms });
  };
  push('session_meta', {
    session_id: threadId, id: threadId, timestamp: new Date(ms).toISOString(), cwd: workspace,
    runtime_workspace_roots: [workspace], originator: 'clikcode', cli_version: options.cliVersion,
    source: 'vscode', model_provider: 'openai', history_mode: 'paginated',
  });
  const turns = record.turns.filter((turn) => turn.user.trim() || turn.attachments.length || turn.parts.length || turn.providerNote);
  turns.forEach((turn: CanonicalTurn, position) => {
    const turnId = makeId(ms);
    const started = Math.floor(ms / 1000);
    const startedMs = ms;
    push('event_msg', { type: 'task_started', turn_id: turnId, started_at: started, collaboration_mode_kind: 'default' });
    const request = [turn.providerNote ?? '', turn.user, ...(turn.attachments.length ? [`Attached files:\n${turn.attachments.map((file) => `- ${file}`).join('\n')}`] : [])]
      .filter((part) => part.trim()).join('\n\n');
    if (request) {
      push('response_item', { type: 'message', id: `msg_${makeId(ms)}`, role: 'user', content: [{ type: 'input_text', text: request }] });
      completed(turnId, { type: 'UserMessage', id: makeId(ms), content: [{ type: 'text', text: request }] });
    }
    const lastText = turn.parts.reduce((last, part, index) => (part.type === 'text' && part.text.trim() ? index : last), -1);
    const interrupted = turn.interrupted && position === turns.length - 1;
    let finalText = '';
    turn.parts.forEach((part, index) => {
      if (part.type === 'text') {
        const said = part.text.trim();
        if (!said) return;
        const phase = index === lastText && !interrupted ? 'final_answer' : 'commentary';
        if (phase === 'final_answer') finalText = said;
        const id = `msg_${makeId(ms)}`;
        push('response_item', { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text: said }], phase });
        completed(turnId, { type: 'AgentMessage', id, content: [{ type: 'Text', text: said }], phase });
        return;
      }
      const call = part.call;
      const callId = `call_${makeId(ms).replace(/-/g, '')}`;
      const mapped = codexCallFor(call, workspace);
      const body = outputText(call);
      const status = call.status === 'done' ? 'completed' : 'failed';
      if (mapped.kind === 'function') {
        push('response_item', { type: 'function_call', name: mapped.name, arguments: mapped.arguments, call_id: callId });
        push('response_item', { type: 'function_call_output', call_id: callId, output: body });
        return;
      }
      const script = mapped.kind === 'command'
        ? `const r = await tools.exec_command(${JSON.stringify({ cmd: mapped.cmd, workdir: workspace })}); text(r.output);\n`
        : `const patch = ${JSON.stringify(mapped.patch)};\ntext(await tools.apply_patch(patch));\n`;
      push('response_item', { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'exec', input: script });
      const result = mapped.kind === 'patch' && call.status === 'done' && !call.output?.length ? '{}' : body;
      push('response_item', { type: 'custom_tool_call_output', call_id: callId, output: scriptOutput(result) });
      const itemId = `exec-${makeId(ms)}`;
      if (mapped.kind === 'command') {
        completed(turnId, {
          type: 'CommandExecution', id: itemId, command: ['/bin/bash', '-lc', mapped.cmd], cwd: `file://${workspace}`,
          parsed_cmd: [{ type: 'unknown', cmd: mapped.cmd }], source: 'unified_exec_startup', status,
          stdout: body, stderr: '', aggregated_output: body, exit_code: call.exitCode ?? (call.status === 'done' ? 0 : 1),
          duration: { secs: 0, nanos: 0 }, formatted_output: body,
        });
      } else {
        const changes = Object.fromEntries(Object.entries(mapped.changes).map(([path, change]) => [path, { ...change, move_path: null }]));
        const files = Object.keys(mapped.changes).map((path) => `M ${path}`).join('\n');
        completed(turnId, {
          type: 'FileChange', id: itemId, changes, status,
          stdout: status === 'completed' ? `Success. Updated the following files:\n${files}\n` : body, stderr: '',
        });
      }
    });
    const end = Math.floor(ms / 1000);
    if (interrupted) {
      push('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted', started_at: started, completed_at: end, duration_ms: ms - startedMs });
    } else {
      push('event_msg', {
        type: 'task_complete', turn_id: turnId, last_agent_message: finalText || null,
        started_at: started, completed_at: end, duration_ms: ms - startedMs,
      });
    }
  });
  return records;
}

/** The taking-over account's CODEX_HOME, only when the environment names one
 *  that is not the user's own `~/.codex`: an unprofiled write would land in
 *  their own Codex history. */
function profileCodexHome(environment: NativeThreadWriteContext['environment']): string | undefined {
  const home = environment.CODEX_HOME?.trim();
  if (!home || !isAbsolute(home)) return undefined;
  return resolve(home) === resolve(homedir(), '.codex') ? undefined : resolve(home);
}

export const codexThreadWriter: NativeThreadWriter = {
  testedVersions: CODEX_WRITER_TESTED_VERSIONS,
  versionOk(context) {
    const version = context.version?.trim();
    return Boolean(version && (CODEX_WRITER_TESTED_VERSIONS as readonly string[]).includes(version));
  },
  async write(record, context): Promise<NativeThreadWritten | undefined> {
    const codexHome = profileCodexHome(context.environment);
    if (!codexHome || !record.turns.length) return undefined;
    const startMs = Date.now();
    const threadId = uuidv7(startMs);
    const records = codexRolloutRecords(record, {
      threadId, workspace: context.workspace, cliVersion: context.version!.replace(/^codex-cli\s+/, ''), startMs,
    });
    if (records.length < 2) return undefined;
    const path = join(codexHome, codexRolloutRelativePath(threadId, startMs));
    try {
      await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
      await atomicWriteFile(path, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
      if (!await reconcileCodexThreadRow(codexHome, threadId, path)) throw new Error('state row');
    } catch {
      // fail-open-ok: a partial thread is removed; the caller transfers instead.
      await rm(path, { force: true }).catch(() => undefined);
      return undefined;
    }
    return { nativeId: threadId };
  },
};

/** OpenCode and Kilo: a conversation written as the vendor's own thread
 * (NativeThreadWriter), through the vendor's own `import` command.
 *
 * Both keep every conversation as rows in one SQLite database
 * (`<XDG_DATA_HOME>/opencode/opencode.db`, `.../kilo/...`), so nothing is
 * written to it directly: the record becomes the JSON `opencode export`
 * prints, and `<binary> import <file>` inserts it. Read from the 1.18.32
 * binary, import validates every message and part against the vendor's own
 * schema and takes the session's projectID, directory and path from the
 * folder it runs in -- so it runs in the conversation's workspace -- and
 * prints `Imported session: <id>`.
 *
 * The format is the one a real `opencode export` printed (1.18.32, a
 * big-pickle turn that called bash/read/edit/write/grep/glob): one user
 * message per request, then one assistant message per step -- the text the
 * model said, then the calls it made, each a `tool` part named for
 * OpenCode's own tool with its input and output -- framed by step-start and
 * step-finish parts. Ids are OpenCode's own shape (`ses_`/`msg_`/`prt_`, a
 * 48-bit time-and-counter prefix then base62): messages and parts are read
 * back in id order, so they have to sort the way the conversation went.
 *
 * Calls are written as OpenCode's own tools, whoever made them (a Claude
 * `Bash` or a Codex `exec_command` becomes `bash`, a Codex `apply_patch` the
 * `edit`/`write` it amounts to). A call with no OpenCode equivalent (an MCP
 * tool, a web search, a todo list) is written as text saying what was
 * called and what came back: a tool part under a name the model was never
 * offered is one it may disown. No reasoning is written.
 *
 * ACP and the CLI read the same database, so the thread is not pinned to a
 * transport. Verified live on opencode 1.18.32 (opencode/big-pickle) and
 * kilo 7.7.6 (kilo/cohere/north-mini-code:free): a Codex-made record (a
 * codeword, an exec_command `ls`, an apply_patch edit) written here, then a
 * ClikCode turn over ACP (session/load) and a CLI `run --session` both
 * recalled the codeword, the listed files and the edit. Assistant messages
 * name the provider/model that produced them: an OpenCode -> Kilo -> OpenCode
 * conversation (2026-10-04) resumed natively on both, and OpenCode, asked
 * what it did on the other provider, named Kilo Code CLI and its turn.
 *
 * Accounts of these harnesses share the user's own data directory (no
 * profile variable), so the thread lands where every OpenCode turn ClikCode
 * runs lands: in the history the account already uses. */

import { jsonPartText, sqliteOpenings } from './sqlite-openings.js';
import { carrySqliteSession, progressQuery, type SqliteCarrySpec } from './sqlite-carry.js';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { captureNativeHarnessOutput } from '../../../harness/transport/native/command.js';
import type { CanonicalPart, CanonicalRecord, CanonicalToolCall, CanonicalTurn } from '../../canonical.js';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionStore, type NativeThreadWriteContext, type NativeThreadWriter, type NativeThreadWritten } from '../stores.js';

type Json = Record<string, unknown>;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_RANDOM_LENGTH = 14;
const MASK_48 = (1n << 48n) - 1n;

/** OpenCode's Identifier.create: `<prefix>_` + 12 hex digits of
 *  (ms * 0x1000 + counter) truncated to 48 bits -- bit-inverted for a
 *  descending id (sessions) -- + 14 random base62 characters. */
export function openCodeId(prefix: 'ses' | 'msg' | 'prt', ms: number, counter: number, descending = false, random?: string): string {
  let value = (BigInt(Math.max(0, Math.floor(ms))) * 0x1000n + BigInt(counter)) & MASK_48;
  if (descending) value = ~value & MASK_48;
  const tail = random ?? [...randomBytes(ID_RANDOM_LENGTH)].map((byte) => BASE62[byte % 62]).join('');
  return `${prefix}_${value.toString(16).padStart(12, '0')}${tail}`;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    // Codex's `shell` sends argv: ["bash", "-lc", "<script>"].
    if (value.length === 3 && /(^|\/)(ba|z)?sh$/.test(value[0]!) && /^-l?c$/.test(value[1]!)) return value[2];
    return value.join(' ');
  }
  return undefined;
}

function absolute(path: string, workspace: string): string {
  return isAbsolute(path) ? path : resolve(workspace, path);
}

/** One call as OpenCode would have made it. */
export interface OpenCodeCall {
  tool: string;
  input: Json;
  /** Shown as the tool part's title, as OpenCode titles its own. */
  title: string;
}

const COMMAND_TOOLS = new Set(['bash', 'shell', 'exec', 'exec_command', 'run_shell_command', 'run_terminal_cmd', 'terminal', 'execute', 'command', 'local_shell']);
const EDIT_TOOLS = new Set(['edit', 'multiedit', 'str_replace_based_edit_tool', 'str_replace_editor', 'replace', 'edit_file']);
const WRITE_TOOLS = new Set(['write', 'write_file', 'create_file']);
const READ_TOOLS = new Set(['read', 'read_file', 'view', 'cat']);
const GREP_TOOLS = new Set(['grep', 'search', 'rg', 'search_file_content', 'grep_search', 'codebase_search']);
const GLOB_TOOLS = new Set(['glob', 'find', 'file_search', 'find_files']);
const FETCH_TOOLS = new Set(['webfetch', 'fetch', 'web_fetch', 'read_url', 'url_fetch']);
const AGENT_TOOLS = new Set(['task', 'agent', 'spawn_agent', 'subagent']);

function filePathOf(input: Json): string | undefined {
  return text(input.filePath) ?? text(input.file_path) ?? text(input.path) ?? text(input.file) ?? text(input.absolute_path);
}

/** A Codex patch, file by file, as the edit/write calls it amounts to. */
function patchCalls(patch: string, workspace: string): OpenCodeCall[] {
  const calls: OpenCodeCall[] = [];
  const sections = patch.split(/^(?=\*\*\* (?:Add|Update|Delete) File: )/m).filter((section) => section.startsWith('*** '));
  for (const section of sections) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/m.exec(section);
    if (!header) continue;
    const path = absolute(header[2]!.trim(), workspace);
    const body = section.split('\n').slice(1).filter((line) => line !== '' && !/^\*\*\* (End Patch|Move to:|End of File)/.test(line));
    if (header[1] === 'Delete') {
      calls.push({ tool: 'bash', input: { command: `rm ${shellQuote(path)}`, description: `Delete ${path}` }, title: `rm ${path}` });
    } else if (header[1] === 'Add') {
      const content = body.filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n');
      calls.push({ tool: 'write', input: { filePath: path, content: `${content}\n` }, title: path });
    } else {
      // Each hunk is its own edit: old = context + removed, new = context + added.
      const hunks: string[][] = [[]];
      for (const line of body) {
        if (line.startsWith('@@')) { if (hunks.at(-1)!.length) hunks.push([]); continue; }
        hunks.at(-1)!.push(line);
      }
      for (const hunk of hunks.filter((lines) => lines.some((line) => line.startsWith('+') || line.startsWith('-')))) {
        const side = (keep: '+' | '-'): string => hunk
          .filter((line) => !line.startsWith(keep === '+' ? '-' : '+'))
          .map((line) => line.slice(1)).join('\n');
        calls.push({ tool: 'edit', input: { filePath: path, oldString: side('-'), newString: side('+') }, title: path });
      }
    }
  }
  return calls;
}

function shellQuote(value: string): string {
  return /^[\w./@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The edit(s) a recorded change amounts to, from its arguments or, for a
 *  call recorded without them, from the diff ClikCode drew. */
function editCalls(call: CanonicalToolCall, workspace: string): OpenCodeCall[] {
  const input = call.input ?? {};
  const patch = text(input.input) ?? text(input.patch) ?? text(input.patchText);
  if (patch?.includes('*** Begin Patch')) return patchCalls(patch, workspace);
  const file = filePathOf(input) ?? (call.files[0] || undefined);
  const edits = Array.isArray(input.edits) ? input.edits as Json[] : [input];
  const pairs = edits.flatMap((edit) => {
    const before = text(edit.oldString) ?? text(edit.old_string) ?? text(edit.old_str);
    const after = text(edit.newString) ?? text(edit.new_string) ?? text(edit.new_str);
    return before !== undefined && after !== undefined ? [{ before, after }] : [];
  });
  if (file && pairs.length) {
    const path = absolute(file, workspace);
    return pairs.map(({ before, after }) => ({ tool: 'edit', input: { filePath: path, oldString: before, newString: after }, title: path }));
  }
  const content = text(input.content) ?? text(input.file_text) ?? text(input.text);
  if (file && content !== undefined) {
    const path = absolute(file, workspace);
    return [{ tool: 'write', input: { filePath: path, content }, title: path }];
  }
  return (call.diff ?? []).flatMap((diff): OpenCodeCall[] => {
    if (!diff.path || !diff.lines.length) return [];
    const path = absolute(diff.path, workspace);
    if (diff.change === 'delete') return [{ tool: 'bash', input: { command: `rm ${shellQuote(path)}`, description: `Delete ${path}` }, title: `rm ${path}` }];
    const lines = diff.lines.filter((line) => line.kind !== 'gap');
    const newString = lines.filter((line) => line.kind !== 'removed').map((line) => line.text).join('\n');
    if (diff.change === 'add' || diff.priorUnknown) return [{ tool: 'write', input: { filePath: path, content: newString }, title: path }];
    const oldString = lines.filter((line) => line.kind !== 'added').map((line) => line.text).join('\n');
    return [{ tool: 'edit', input: { filePath: path, oldString, newString }, title: path }];
  });
}

/** Maps a recorded call, whoever made it, to the OpenCode tool calls it
 *  amounts to: none when OpenCode has no tool for it (written as text). */
export function openCodeCallsFor(call: CanonicalToolCall, workspace: string): OpenCodeCall[] {
  const name = call.name.toLowerCase();
  const input = call.input ?? {};
  const isEdit = call.category === 'edit' || EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name) || name === 'apply_patch';
  if (isEdit) {
    const edits = editCalls(call, workspace);
    if (edits.length) return edits;
  }
  const command = text(input.command) ?? text(input.cmd)
    ?? (call.category === 'run' || COMMAND_TOOLS.has(name) ? call.target : undefined);
  if (command?.trim() && (call.category === 'run' || COMMAND_TOOLS.has(name))) {
    const description = text(input.description) ?? `Runs ${command.split('\n')[0]!.slice(0, 60)}`;
    return [{ tool: 'bash', input: { command, description }, title: command.split('\n')[0]! }];
  }
  if (AGENT_TOOLS.has(name) || call.agent) {
    const prompt = text(input.prompt) ?? text(input.message) ?? text(input.description) ?? call.target;
    if (prompt) {
      const description = (text(input.description) ?? prompt).split('\n')[0]!.slice(0, 60);
      return [{ tool: 'task', input: { description, prompt, subagent_type: text(input.subagent_type) ?? 'general' }, title: description }];
    }
  }
  const file = filePathOf(input) ?? (call.category === 'read' || READ_TOOLS.has(name) ? call.target : undefined);
  if ((call.category === 'read' || READ_TOOLS.has(name)) && file && name !== 'list' && name !== 'ls') {
    const path = absolute(file, workspace);
    return [{ tool: 'read', input: { filePath: path }, title: path }];
  }
  const pattern = text(input.pattern) ?? text(input.query) ?? text(input.regex);
  const searchPath = text(input.path) ?? text(input.dir_path) ?? text(input.directory);
  const scoped = searchPath ? { path: absolute(searchPath, workspace) } : {};
  if (GLOB_TOOLS.has(name) && (pattern ?? call.target)) {
    return [{ tool: 'glob', input: { pattern: pattern ?? call.target!, ...scoped }, title: pattern ?? call.target! }];
  }
  if ((GREP_TOOLS.has(name) || (call.category === 'search' && name !== 'web search' && name !== 'web_search')) && (pattern ?? call.target)) {
    const include = text(input.include) ?? text(input.glob);
    return [{ tool: 'grep', input: { pattern: pattern ?? call.target!, ...scoped, ...(include ? { include } : {}) }, title: pattern ?? call.target! }];
  }
  const url = text(input.url) ?? (FETCH_TOOLS.has(name) && /^https?:\/\//.test(call.target ?? '') ? call.target : undefined);
  if ((FETCH_TOOLS.has(name) || call.category === 'fetch') && url && /^https?:\/\//.test(url)) {
    return [{ tool: 'webfetch', input: { url, format: 'markdown' }, title: url }];
  }
  return [];
}

function outputText(call: CanonicalToolCall): string {
  const lines = call.output ?? [];
  const omitted = call.outputOmitted ? `[${call.outputOmitted} lines omitted]` : '';
  const body = [...(omitted && call.outputTail ? [omitted] : []), ...lines, ...(omitted && !call.outputTail ? [omitted] : [])].join('\n');
  const exit = call.exitCode !== undefined && call.exitCode !== 0 ? `${body ? '\n' : ''}Process exited with code ${call.exitCode}` : '';
  return `${body}${exit}`;
}

/** A call OpenCode has no tool for, told as text. */
function callAsText(call: CanonicalToolCall): string {
  const args = call.input ? ` ${JSON.stringify(call.input)}` : call.target ? ` ${call.target}` : '';
  const output = outputText(call);
  const state = call.status === 'unfinished' ? ' (interrupted before it finished)' : call.status === 'failed' ? ' (failed)' : '';
  return `[Called ${call.name}${args}${state}]${output ? `\n${output}` : ''}`;
}

/** The provider/model an assistant message names: the one that produced the
 *  turn (`kilo/cohere/north-mini-code:free` on an OpenCode thread), so the
 *  resumed model sees another provider's turns as that provider's. User
 *  messages keep the receiving model: OpenCode resumes on the last user
 *  message's model. A turn with no recorded model is the receiving one's. */
function producingModel(turn: CanonicalTurn, providerID: string, modelID: string): { providerID: string; modelID: string } {
  const model = turn.origin.model?.trim();
  if (!model) return { providerID, modelID };
  const slash = model.indexOf('/');
  if (slash > 0) return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
  return { providerID: turn.origin.provider ?? turn.origin.harness ?? providerID, modelID: model };
}

/** What a write needs besides the record; fixed in tests for golden output. */
export interface OpenCodeExportOptions {
  workspace: string;
  /** `provider/model`, as ClikCode passes `--model`. */
  model: string;
  /** The vendor build, recorded as the session's version. */
  version: string;
  /** Epoch ms of the first id; each later one is a millisecond on. */
  startMs: number;
  /** The random tail of ids; random by default. */
  random?: () => string;
}

/** The thread as `opencode export` prints it. Pure: everything time- or
 *  id-dependent comes from `options`. */
export function openCodeExport(record: CanonicalRecord, options: OpenCodeExportOptions): { info: Json; messages: Array<{ info: Json; parts: Json[] }> } {
  const slash = options.model.indexOf('/');
  const providerID = options.model.slice(0, slash);
  const modelID = options.model.slice(slash + 1);
  let ms = options.startMs;
  const id = (prefix: 'ses' | 'msg' | 'prt', descending = false): string => {
    const made = openCodeId(prefix, ms, 1, descending, options.random?.());
    ms += 1;
    return made;
  };
  const sessionID = id('ses', true);
  const created = options.startMs;
  const messages: Array<{ info: Json; parts: Json[] }> = [];
  const workspace = options.workspace;
  const turns = record.turns.filter((turn) => turn.user.trim() || turn.attachments.length || turn.parts.length || turn.providerNote);
  const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

  turns.forEach((turn: CanonicalTurn, position) => {
    const interrupted = turn.interrupted && position === turns.length - 1;
    const request = [turn.providerNote ?? '', turn.user, ...(turn.attachments.length ? [`Attached files:\n${turn.attachments.map((file) => `- ${file}`).join('\n')}`] : [])]
      .filter((part) => part.trim()).join('\n\n') || '(continued)';
    const produced = producingModel(turn, providerID, modelID);
    const userID = id('msg');
    messages.push({
      info: { role: 'user', time: { created: ms }, agent: 'build', model: { providerID, modelID }, id: userID, sessionID },
      parts: [{ type: 'text', text: request, id: id('prt'), sessionID, messageID: userID }],
    });
    // Steps: what was said, then the calls made after it. Text after a call
    // starts the next step, as the model would have said it after the result.
    const steps: CanonicalPart[][] = [[]];
    for (const part of turn.parts) {
      const current = steps.at(-1)!;
      if (part.type === 'text' && current.some((item) => item.type === 'tool')) steps.push([part]);
      else current.push(part);
    }
    const nonEmpty = steps.filter((step) => step.length);
    nonEmpty.forEach((step, stepIndex) => {
      const messageID = id('msg');
      const start = ms;
      const last = stepIndex === nonEmpty.length - 1;
      const parts: Json[] = [{ type: 'step-start', id: id('prt'), sessionID, messageID }];
      let calls = 0;
      let said = '';
      const flushText = (): void => {
        if (!said.trim()) { said = ''; return; }
        const at = ms;
        parts.push({ type: 'text', text: said.trim(), time: { start: at, end: at }, id: id('prt'), sessionID, messageID });
        said = '';
      };
      for (const part of step) {
        if (part.type === 'text') { said += part.text; continue; }
        const mapped = openCodeCallsFor(part.call, workspace);
        if (!mapped.length) { said += `${said && !said.endsWith('\n') ? '\n\n' : ''}${callAsText(part.call)}\n\n`; continue; }
        flushText();
        const output = outputText(part.call);
        for (const call of mapped) {
          calls += 1;
          const at = ms;
          const state = part.call.status === 'done'
            ? { status: 'completed', input: call.input, output, title: call.title, metadata: {}, time: { start: at, end: at } }
            : { status: 'error', input: call.input, error: part.call.status === 'unfinished' ? 'Tool execution aborted' : (output || 'Tool execution failed'), time: { start: at, end: at } };
          parts.push({ type: 'tool', tool: call.tool, callID: `call_${randomTail(options)}`, state, id: id('prt'), sessionID, messageID });
        }
      }
      flushText();
      const open = interrupted && last;
      const finish = calls ? 'tool-calls' : open ? undefined : 'stop';
      if (!open) parts.push({ reason: finish, type: 'step-finish', tokens: zeroTokens, cost: 0, id: id('prt'), sessionID, messageID });
      messages.push({
        info: {
          parentID: userID, role: 'assistant', mode: 'build', agent: 'build', path: { cwd: workspace, root: workspace },
          cost: 0, tokens: zeroTokens, modelID: produced.modelID, providerID: produced.providerID,
          time: open ? { created: start } : { created: start, completed: ms },
          ...(finish && !open ? { finish } : {}),
          ...(open ? { error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } : {}),
          id: messageID, sessionID,
        },
        parts,
      });
    });
  });
  const firstRequest = turns.find((turn) => turn.user.trim())?.user.trim().split('\n')[0] ?? 'Conversation';
  const title = firstRequest.length > 60 ? `${firstRequest.slice(0, 57)}...` : firstRequest;
  const info: Json = {
    id: sessionID, slug: sessionID.slice(-8).toLowerCase(), projectID: 'global', directory: workspace, title,
    version: options.version, time: { created, updated: ms },
  };
  return { info, messages };
}

function randomTail(options: OpenCodeExportOptions): string {
  return options.random?.() ?? [...randomBytes(ID_RANDOM_LENGTH)].map((byte) => BASE62[byte % 62]).join('');
}

/** A writer for one OpenCode-family vendor, run through its own binary. */
export function openCodeFamilyThreadWriter(testedVersions: readonly string[]): NativeThreadWriter {
  return {
    testedVersions,
    versionOk(context) {
      const version = context.version?.trim().replace(/^v/, '');
      return Boolean(version && testedVersions.includes(version));
    },
    async write(record, context: NativeThreadWriteContext): Promise<NativeThreadWritten | undefined> {
      const model = context.model?.trim();
      // The resumed turn's model is the last user message's (OpenCode's
      // lastModel) unless --model says otherwise: a guessed one would
      // silently switch it.
      if (!model || !/^[^/\s]+\/\S+$/.test(model) || !record.turns.length || !isAbsolute(context.workspace)) return undefined;
      const exported = openCodeExport(record, {
        workspace: context.workspace, model, version: context.version!.trim().replace(/^v/, ''), startMs: Date.now(),
      });
      if (!exported.messages.length) return undefined;
      const nativeId = String(exported.info.id);
      const directory = await mkdtemp(join(tmpdir(), 'clikcode-thread-'));
      try {
        const file = join(directory, `${nativeId}.json`);
        await writeFile(file, JSON.stringify(exported), { mode: 0o600 });
        // --pure: no plugins -- importing is a database insert, and a plugin
        // may reach the network or open a session of its own.
        const output = await captureNativeHarnessOutput(context.harness, ['import', '--pure', file], context.environment, 30_000, context.workspace);
        if (/Imported session: (\S+)/.exec(output)?.[1] === nativeId) return { nativeId };
        throw new Error('import did not report the session');
      } catch {
        // fail-open-ok: import validates message by message after inserting
        // the session row, so a refusal can leave part of it behind; the
        // caller transfers instead.
        await captureNativeHarnessOutput(context.harness, ['session', 'delete', '--pure', nativeId], context.environment, 15_000, context.workspace)
          .catch(() => undefined);
        return undefined;
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/** Builds whose import and resume were checked live (`--version`). */
export const OPENCODE_WRITER_TESTED_VERSIONS = ['1.18.32'] as const;
export const KILO_WRITER_TESTED_VERSIONS = ['7.7.6'] as const;

export const openCodeThreadWriter = openCodeFamilyThreadWriter(OPENCODE_WRITER_TESTED_VERSIONS);
export const kiloThreadWriter = openCodeFamilyThreadWriter(KILO_WRITER_TESTED_VERSIONS);

/** One conversation in an OpenCode-family database, as opencode 1.18.32 and
 *  kilo 7.7.6 lay it out (schemas read from a database each made in
 *  vendor-sandbox; a real turn's rows checked). The `session` row, its
 *  `message`s and `part`s -- what a resume reads -- plus everything else the
 *  vendor keys on the session: todos, a share, the context epoch, queued
 *  input, the v2 `session_message` log, the event-sourcing `event_sequence`
 *  and `event` rows (aggregate = the session; every turn writes them), and
 *  Kilo's agent board. Ids are the vendor's own globally unique ones (`ses_`,
 *  `msg_`, `prt_`, `evt_`), so they are carried as they are. The `project`
 *  and `workspace` the session names are shared with other sessions, so they
 *  are added only when missing -- a project id is the repository's root
 *  commit (or `global`), the same in every profile.
 *
 *  Progress is the part ids: time-ordered, and a turn only adds parts. */
function openCodeCarrySpec(name: string): SqliteCarrySpec {
  return {
    database: (environment) => join(openCodeDataRoot(environment, name), `${name}.db`),
    session: { table: 'session', key: 'id', identity: ['time_created'], parent: 'parent_id' },
    rows: [
      { table: 'message', key: 'session_id' },
      { table: 'part', key: 'session_id' },
      { table: 'todo', key: 'session_id' },
      { table: 'session_share', key: 'session_id' },
      { table: 'session_context_epoch', key: 'session_id' },
      { table: 'session_input', key: 'session_id' },
      { table: 'session_message', key: 'session_id' },
      { table: 'event_sequence', key: 'aggregate_id' },
      { table: 'event', key: 'aggregate_id' },
      { table: 'kilo_board', key: 'root_session_id' },
      { table: 'kilo_board_message', key: 'board_root_session_id' },
    ],
    shared: [
      { table: 'project', key: 'id', via: 'project_id' },
      { table: 'workspace', key: 'id', via: 'workspace_id' },
    ],
    required: {
      session: ['id', 'project_id', 'directory', 'title', 'version', 'time_created', 'time_updated'],
      message: ['id', 'session_id', 'data'],
      part: ['id', 'message_id', 'session_id', 'data'],
    },
    progress: progressQuery('SELECT id AS k FROM {db}.part WHERE session_id = ? ORDER BY id'),
  };
}

function openCodeDataRoot(environment: NativeSessionEnvironment, name: string): string {
  return join(nativeDataRoot(environment, 'XDG_DATA_HOME', join(environment.HOME?.trim() || homedir(), '.local', 'share')), name);
}

/** The store: `<XDG_DATA_HOME>/<name>`, one SQLite database holding every
 *  conversation, so there is no per-conversation file to `locate`: a carry
 *  moves the session's rows (openCodeCarrySpec). */
function openCodeFamilyStore(name: string, writer: NativeThreadWriter): NativeSessionStore {
  const carry = openCodeCarrySpec(name);
  return {
    root: (environment) => openCodeDataRoot(environment, name),
    carry: (input) => carrySqliteSession(carry, input),
    writer,
    // A message's text is its parts; the user's first text part (observed
    // on opencode 1.18.32).
    openings: (root, nativeIds) => sqliteOpenings(join(root, `${name}.db`), nativeIds,
      "SELECT p.data AS text FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ? AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text' ORDER BY p.time_created, p.id LIMIT 1",
      jsonPartText),
  };
}

export const openCodeSessionStore = openCodeFamilyStore('opencode', openCodeThreadWriter);
export const kiloSessionStore = openCodeFamilyStore('kilo', kiloThreadWriter);

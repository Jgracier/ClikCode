/** A conversation as a Claude Code session transcript (`<id>.jsonl`).
 *
 * One serializer, three writers: Claude Code reads the file directly
 * (claude-store.ts), and Goose (`goose session import`) and Hermes
 * (`hermes sessions import --from claude`) import it (claude-import.ts). So
 * the layout below is the one Claude Code 2.1.288 resumes, verified live:
 *
 * - every record carries type, message, uuid, parentUuid, sessionId AND
 *   timestamp (no timestamp: "No conversation found");
 * - parentUuid chains every record to the one before it (a broken chain keeps
 *   only the last message);
 * - the user's request is a string `message.content`; an assistant block is
 *   its own record, `message` an API message ({id, type, role, model,
 *   content, stop_reason, usage}), blocks of one API message sharing its id;
 *   a tool's result is a user record whose content is
 *   `[{type: 'tool_result', tool_use_id, content}]`.
 * - no thinking blocks: their signatures cannot be forged.
 *
 * Foreign calls are mapped onto Claude Code's own tools (claudeToolUses).
 * Claude accepts any tool name in history, but a model shown `apply_patch` or
 * `shell` calls it never had disowns them ("I hallucinated those"); shown its
 * own Bash/Read/Edit, it treats the work as its own. A call with no Claude
 * equivalent (an MCP tool of another vendor, a plan update) becomes one line
 * of assistant text saying what ran, so the history still says it happened. */

import { randomUUID } from 'node:crypto';
import { withProviderNote, type CanonicalRecord, type CanonicalToolCall, type CanonicalTurn } from '../../canonical.js';
import { absolutePath, shellQuote } from './thread-writer-files.js';

/** The harness command whose calls are already Claude Code's own. */
const CLAUDE_ORIGIN = 'claude';

export interface ClaudeToolUse { name: string; input: Record<string, unknown> }

export interface ClaudeThreadOptions {
  /** The new session's id: the file's name and every record's sessionId. */
  sessionId: string;
  /** The folder the thread resumes in (absolute). */
  cwd: string;
  /** Recorded on assistant messages whose turn has no model of its own; the
   *  resume picks its own model. A turn's producing model is recorded on its
   *  messages, whoever produced it (Claude Code 2.1.288 resumed a thread
   *  whose messages named a GPT model). */
  model: string | null;
  /** The Claude Code build the records claim to come from. */
  version: string;
  /** The last record's time; earlier records count back 1 ms each. */
  now?: Date;
  /** Fresh uuids (tests pass a counter). */
  uuid?: () => string;
  /** `text`: every call as a line of assistant text naming the Claude tool,
   *  its input and its result, instead of tool_use/tool_result blocks -- for
   *  an importer that keeps a call's name but drops its input and result
   *  (Hermes 0.20.5 stores `[ran tool: Bash]`). Default `blocks`. */
  toolCalls?: 'blocks' | 'text';
}

const DEFAULT_MODEL = 'claude-sonnet-4-5';
/** Most output lines an unmapped call's text line repeats. */
const TEXT_LINE_OUTPUT_LINES = 20;

type Kind = 'run' | 'list' | 'read' | 'edit' | 'grep' | 'glob' | 'websearch' | 'fetch' | 'agent';

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

function pick(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = str(input[key]);
    if (value) return value;
  }
  return undefined;
}

/** What kind of Claude tool a call is, from ClikCode's category first, then
 * the vendor's tool name or the row's verb. Undefined: no equivalent. */
function callKind(call: CanonicalToolCall): Kind | undefined {
  const name = call.name.trim();
  const label = call.label.trim();
  if (/^mcp__/.test(name)) return undefined;
  if (call.agent || /^(agent|task|spawn_agent|subagent|delegate)/i.test(name)) return 'agent';
  if (/^Web search\b/.test(label) || /^web_?search$/i.test(name)) return 'websearch';
  if (/^List\b/.test(label) || /^(list|ls|list_dir|list_directory)$/i.test(name)) return 'list';
  if (/^Glob\b/.test(label) || /^(glob|find_files)$/i.test(name)) return 'glob';
  switch (call.category) {
    case 'run': return 'run';
    case 'read': return 'read';
    case 'edit': return 'edit';
    case 'search': return 'grep';
    case 'fetch': return /^https?:\/\//i.test(fetchUrl(call) ?? '') ? 'fetch' : 'websearch';
    default: break;
  }
  if (/^(shell|bash|exec_command|local_shell|run_shell_command|shell_command|terminal|execute|run_terminal_cmd|run_command|command)$/i.test(name)) return 'run';
  if (/^(apply_patch|patch|edit|multiedit|write|str_replace\w*|write_file|replace|create_file|edit_file)$/i.test(name)) return 'edit';
  if (/^(read|read_file|read_many_files|view|cat|open_file)$/i.test(name)) return 'read';
  if (/^(grep|search|search_files|rg|ripgrep|codebase_search|grep_search)$/i.test(name)) return 'grep';
  if (/^(fetch|web_?fetch|read_url|curl)$/i.test(name)) return 'fetch';
  return undefined;
}

function fetchUrl(call: CanonicalToolCall): string | undefined {
  return pick(call.input ?? {}, 'url', 'uri', 'href') ?? call.target;
}

/** The command line of a shell call: Codex sends `["bash", "-lc", "..."]`. */
function shellCommand(call: CanonicalToolCall): string | undefined {
  const input = call.input ?? {};
  const command = input.command ?? input.cmd ?? input.argv;
  if (Array.isArray(command)) {
    const parts = command.map(String);
    const shell = /(^|\/)(ba|z|da)?sh$/.test(parts[0] ?? '') && /^-\w*c$/.test(parts[1] ?? '');
    return (shell ? parts.slice(2).join(' ') : parts.join(' ')).trim() || undefined;
  }
  return str(command) ?? pick(input, 'script', 'commandLine') ?? call.target;
}

function callPath(call: CanonicalToolCall, cwd: string): string | undefined {
  const path = pick(call.input ?? {}, 'file_path', 'filePath', 'path', 'file', 'filename', 'absolute_path', 'target_file')
    ?? call.files[0] ?? call.target;
  return path ? absolutePath(cwd, path) : undefined;
}

/** `*** Begin Patch` text (Codex apply_patch) as Claude edits: an added file
 * is a Write, each hunk of an updated file an Edit, a deleted file `rm`. */
function patchUses(patch: string, cwd: string): ClaudeToolUse[] {
  const uses: ClaudeToolUse[] = [];
  let file: { op: 'add' | 'update' | 'delete'; path: string; lines: string[] } | undefined;
  const hunk = (lines: string[]): void => {
    const old = lines.filter((line) => !line.startsWith('+')).map((line) => line.slice(1));
    const next = lines.filter((line) => !line.startsWith('-')).map((line) => line.slice(1));
    if (old.length || next.length) {
      uses.push({ name: 'Edit', input: { file_path: file!.path, old_string: old.join('\n'), new_string: next.join('\n') } });
    }
  };
  const flush = (): void => {
    if (!file) return;
    if (file.op === 'add') {
      uses.push({ name: 'Write', input: { file_path: file.path, content: file.lines.map((line) => line.slice(1)).join('\n') + '\n' } });
    } else if (file.op === 'delete') {
      uses.push({ name: 'Bash', input: { command: `rm ${shellQuote(file.path)}` } });
    } else {
      let current: string[] = [];
      for (const line of file.lines) {
        if (line.startsWith('@@')) { hunk(current); current = []; continue; }
        if (/^[ +-]/.test(line) || line === '') current.push(line === '' ? ' ' : line);
      }
      hunk(current);
    }
    file = undefined;
  };
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      flush();
      file = { op: header[1]!.toLowerCase() as 'add' | 'update' | 'delete', path: absolutePath(cwd, header[2]!.trim()), lines: [] };
      continue;
    }
    if (/^\*\*\* End Patch/.test(line)) break;
    if (/^\*\*\* Begin Patch|^\*\*\* End of File/.test(line)) continue;
    // A rename: the hunks still apply to the file as first named.
    if (/^\*\*\* Move to: /.test(line)) continue;
    file?.lines.push(line);
  }
  flush();
  return uses;
}

/** A recorded diff as Claude edits: a new file is a Write, each hunk an Edit. */
function diffUses(call: CanonicalToolCall, cwd: string): ClaudeToolUse[] {
  const uses: ClaudeToolUse[] = [];
  for (const file of call.diff ?? []) {
    const path = file.path ? absolutePath(cwd, file.path) : callPath(call, cwd);
    if (!path) continue;
    if ((file.change === 'add' || (file.priorUnknown && !file.removals)) && !file.omitted && !file.lines.some((line) => line.kind === 'gap')) {
      uses.push({ name: 'Write', input: { file_path: path, content: file.lines.map((line) => line.text).join('\n') + '\n' } });
      continue;
    }
    let hunk: typeof file.lines = [];
    const flush = (): void => {
      const old = hunk.filter((line) => line.kind !== 'added').map((line) => line.text);
      const next = hunk.filter((line) => line.kind !== 'removed').map((line) => line.text);
      if (hunk.some((line) => line.kind !== 'same')) uses.push({ name: 'Edit', input: { file_path: path, old_string: old.join('\n'), new_string: next.join('\n') } });
      hunk = [];
    };
    for (const line of file.lines) {
      if (line.kind === 'gap') flush();
      else hunk.push(line);
    }
    flush();
  }
  return uses;
}

function editUses(call: CanonicalToolCall, cwd: string): ClaudeToolUse[] {
  const input = call.input ?? {};
  const path = callPath(call, cwd);
  const oldString = typeof input.old_string === 'string' ? input.old_string : typeof input.oldString === 'string' ? input.oldString
    : typeof input.old_str === 'string' ? input.old_str : undefined;
  const newString = typeof input.new_string === 'string' ? input.new_string : typeof input.newString === 'string' ? input.newString
    : typeof input.new_str === 'string' ? input.new_str : undefined;
  if (path && oldString !== undefined && newString !== undefined) {
    return [{ name: 'Edit', input: { file_path: path, old_string: oldString, new_string: newString } }];
  }
  const content = typeof input.content === 'string' ? input.content : typeof input.file_text === 'string' ? input.file_text : undefined;
  if (path && content !== undefined) return [{ name: 'Write', input: { file_path: path, content } }];
  const patch = Object.values(input).find((value): value is string => typeof value === 'string' && value.includes('*** Begin Patch'));
  if (patch) {
    const uses = patchUses(patch, cwd);
    if (uses.length) return uses;
  }
  return diffUses(call, cwd);
}

/** The Claude Code tool call(s) that stand for one recorded call; [] when
 * Claude has no equivalent (it is written as a line of text instead). A call
 * Claude Code itself made keeps its name and input. */
export function claudeToolUses(call: CanonicalToolCall, cwd: string, origin?: string): ClaudeToolUse[] {
  if (origin === CLAUDE_ORIGIN && call.input && /^[A-Z]\w*$|^mcp__/.test(call.name)) return [{ name: call.name, input: call.input }];
  const input = call.input ?? {};
  switch (callKind(call)) {
    case 'run': {
      const command = shellCommand(call);
      return command ? [{ name: 'Bash', input: { command } }] : [];
    }
    case 'list': {
      const path = callPath(call, cwd);
      return [{ name: 'Bash', input: { command: path ? `ls ${shellQuote(path)}` : 'ls' } }];
    }
    case 'read': {
      const path = callPath(call, cwd);
      return path ? [{ name: 'Read', input: { file_path: path } }] : [];
    }
    case 'edit': return editUses(call, cwd);
    case 'grep': {
      const pattern = pick(input, 'pattern', 'query', 'regex', 'search', 'q') ?? call.target;
      const path = pick(input, 'path', 'dir', 'directory');
      return pattern ? [{ name: 'Grep', input: { pattern, ...(path ? { path: absolutePath(cwd, path) } : {}) } }] : [];
    }
    case 'glob': {
      const pattern = pick(input, 'pattern', 'glob', 'query') ?? call.target;
      const path = pick(input, 'path', 'dir', 'directory');
      return pattern ? [{ name: 'Glob', input: { pattern, ...(path ? { path: absolutePath(cwd, path) } : {}) } }] : [];
    }
    case 'websearch': {
      const query = pick(input, 'query', 'q', 'search') ?? call.target;
      return query ? [{ name: 'WebSearch', input: { query } }] : [];
    }
    case 'fetch': {
      const url = fetchUrl(call);
      return url ? [{ name: 'WebFetch', input: { url, prompt: pick(input, 'prompt') ?? 'Read the page.' } }] : [];
    }
    case 'agent': {
      const prompt = pick(input, 'prompt', 'message', 'task', 'instructions', 'description') ?? call.target ?? call.label;
      const description = pick(input, 'description') ?? prompt.split(/\s+/).slice(0, 5).join(' ');
      return [{ name: 'Agent', input: { description, prompt, subagent_type: pick(input, 'subagent_type') ?? 'general-purpose' } }];
    }
    default: return [];
  }
}

function outputText(call: CanonicalToolCall): string {
  if (!call.output?.length) return '';
  const lines = [...call.output];
  if (call.outputOmitted) {
    const note = `(${call.outputOmitted} lines omitted)`;
    if (call.outputTail) lines.unshift(note);
    else lines.push(note);
  }
  return lines.join('\n');
}

/** What the tool returned, as Claude Code would have shown it. */
function resultContent(call: CanonicalToolCall, use: ClaudeToolUse, primary: boolean): { content: string; isError: boolean } {
  if (call.status === 'unfinished') return { content: 'The call was interrupted before it finished.', isError: true };
  const failed = call.status === 'failed' || (call.exitCode !== undefined && call.exitCode !== 0);
  let content = primary ? outputText(call) : '';
  if (primary && call.exitCode !== undefined && call.exitCode !== 0) content = `${content}${content ? '\n' : ''}Exit code ${call.exitCode}`;
  if (!content) {
    const path = str(use.input.file_path);
    content = failed ? 'The call failed.'
      : use.name === 'Edit' && path ? `The file ${path} has been updated successfully.`
        : use.name === 'Write' && path ? `File created successfully at: ${path}`
          : '(no output)';
  }
  return { content, isError: failed };
}

/** The line of text standing for a call Claude has no tool for. */
function textLine(call: CanonicalToolCall): string {
  const status = call.status === 'failed' ? ' (failed)' : call.status === 'unfinished' ? ' (interrupted)' : '';
  const output = call.output?.length ? call.output.slice(-TEXT_LINE_OUTPUT_LINES).join('\n') : '';
  return `[Ran ${call.label}${status}]${output ? `\n${output}` : ''}`;
}

function userText(turn: CanonicalTurn): string {
  return withProviderNote(turn, turn.attachments.length ? `${turn.user}\n\nAttached files: ${turn.attachments.join(', ')}` : turn.user);
}

/** How Claude Code opens the summary it writes when it compacts. */
export const CLAUDE_SUMMARY_PREAMBLE = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/** The records of a Claude Code session transcript holding `record`, in order. */
export function claudeThreadRecords(record: CanonicalRecord, options: ClaudeThreadOptions): Record<string, unknown>[] {
  const uuid = options.uuid ?? randomUUID;
  const compact = (): string => uuid().replace(/-/g, '');
  type Pending = { blocks: Block[]; model: string } | { results: { id: string; content: string; isError: boolean }[] } | { user: string };
  const entries: Pending[] = [];
  const model = options.model ?? DEFAULT_MODEL;

  record.turns.forEach((turn, index) => {
    if (turn.user.trim() || turn.attachments.length || turn.providerNote) entries.push({ user: userText(turn) });
    else if (!entries.length) entries.push({ user: '(continued)' });
    const turnModel = turn.origin.model ?? model;
    let blocks: Block[] = [];
    const flushBlocks = (): void => {
      if (blocks.length) entries.push({ blocks, model: turnModel });
      blocks = [];
    };
    for (const part of turn.parts) {
      if (part.type === 'text') {
        if (part.text.trim()) blocks.push({ type: 'text', text: part.text.trim() });
        continue;
      }
      const call = part.call;
      const uses = claudeToolUses(call, options.cwd, turn.origin.harness);
      if (!uses.length) {
        blocks.push({ type: 'text', text: textLine(call) });
        continue;
      }
      if (options.toolCalls === 'text') {
        uses.forEach((use, position) => {
          const result = resultContent(call, use, position === 0);
          blocks.push({ type: 'text', text: `[${use.name} ${JSON.stringify(use.input)}${result.isError ? ' (failed)' : ''}]\n${result.content}` });
        });
        continue;
      }
      const results: { id: string; content: string; isError: boolean }[] = [];
      uses.forEach((use, position) => {
        const id = `toolu_${compact()}`;
        blocks.push({ type: 'tool_use', id, name: use.name, input: use.input });
        results.push({ id, ...resultContent(call, use, position === 0) });
      });
      flushBlocks();
      entries.push({ results });
    }
    flushBlocks();
    // An answer nobody recorded, mid-conversation: say so, rather than put two
    // requests back to back. The newest turn is left as it stands -- the next
    // prompt continues it.
    const last = index === record.turns.length - 1;
    const previous = entries.at(-1);
    if (!last && previous && 'user' in previous) entries.push({ blocks: [{ type: 'text', text: '(No answer was recorded.)' }], model: turnModel });
  });

  // A summary is written as Claude Code writes its own compaction: a boundary
  // that starts a new chain, then the summary as a user message it flags.
  const summarized = record.summary ? 2 : 0;
  const count = summarized + entries.reduce((sum, entry) => sum + ('blocks' in entry ? entry.blocks.length : 1), 0);
  const end = (options.now ?? new Date()).getTime();
  const records: Record<string, unknown>[] = [];
  let parent: string | null = null;
  const push = (type: 'user' | 'assistant', message: Record<string, unknown>, extra: Record<string, unknown> = {}): void => {
    const id = uuid();
    records.push({
      parentUuid: parent, isSidechain: false, userType: 'external', cwd: options.cwd, sessionId: options.sessionId,
      version: options.version, type, message, uuid: id,
      timestamp: new Date(end - (count - records.length - 1)).toISOString(), ...extra,
    });
    parent = id;
  };
  if (record.summary) {
    const boundary = uuid();
    records.push({
      parentUuid: null, isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info',
      compactMetadata: { trigger: 'auto' }, uuid: boundary, timestamp: new Date(end - (count - 1)).toISOString(),
      userType: 'external', cwd: options.cwd, sessionId: options.sessionId, version: options.version,
    });
    parent = boundary;
    push('user', { role: 'user', content: `${CLAUDE_SUMMARY_PREAMBLE}${record.summary.text}` }, { isCompactSummary: true, isVisibleInTranscriptOnly: true });
  }
  for (const entry of entries) {
    if ('user' in entry) {
      push('user', { role: 'user', content: entry.user });
    } else if ('results' in entry) {
      push('user', {
        role: 'user',
        content: entry.results.map((result) => ({
          type: 'tool_result', tool_use_id: result.id, content: result.content, ...(result.isError ? { is_error: true } : {}),
        })),
      });
    } else {
      const messageId = `msg_${compact()}`;
      const stop = entry.blocks.at(-1)?.type === 'tool_use' ? 'tool_use' : 'end_turn';
      for (const block of entry.blocks) {
        push('assistant', {
          id: messageId, type: 'message', role: 'assistant', model: entry.model, content: [block],
          stop_reason: stop, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
        });
      }
    }
  }
  return records;
}

export function claudeThreadJsonl(record: CanonicalRecord, options: ClaudeThreadOptions): string {
  return claudeThreadRecords(record, options).map((item) => JSON.stringify(item)).join('\n') + '\n';
}

/** The project folder Claude Code keeps a workspace's sessions in: every
 * character outside [a-zA-Z0-9] becomes `-` (claude.ts reads both spellings). */
export function claudeProjectDirectoryName(workspace: string): string {
  return workspace.replace(/[^a-zA-Z0-9]/g, '-');
}

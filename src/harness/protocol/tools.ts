/** Naming and categorizing a tool call, per harness. A category decides how
 * the call is painted, so an unmapped tool must still land somewhere sane. */

import { visibleSlice } from '../../tui/render/width.js';
import type { ToolCategory } from '../prompter.js';

/** The one place that decides what a tool row says.
 *
 * Every harness's parser, and ClikCode's own agent, funnels through here, so
 * the same action reads the same whichever vendor ran it: `Read src/x`,
 * `Edit src/x`, `$ npm test`, `Grep TODO`, `Fetch https://…`, `Agent find the
 * retry logic`, `github › create_issue title=…`. The verb comes from what the
 * call does (its category), never from the vendor's spelling of the tool,
 * which is how `Bash(ls)`, `run_command(ls)`, `developer__shell(ls)` and a
 * bare `ls` had become four looks for one command.
 *
 * Only the first line of the detail is kept (marked `…` when there is more),
 * capped, so a multi-line command cannot break the row. A detail that adds nothing is dropped rather than
 * padded; a tool nothing classifies keeps its own name. */
export function formatToolRow(name: string, detail?: string, category?: ToolCategory): string {
  const lines = detail?.trim().split(/\r?\n/) ?? [];
  const firstLine = lines[0]?.trim();
  // More lines are marked, not hidden: `$ ls` must not stand for `ls\nrm -rf x`.
  const shown = firstLine ? visibleSlice(lines.length > 1 ? `${firstLine} …` : firstLine, 72) : '';
  const verb = toolVerb(name, category ?? toolCategory(name));
  if (verb === '$') return shown ? `$ ${shown}` : name;
  return shown ? `${verb} ${shown}` : verb;
}

/** The word a row starts with. `$` for a shell command. */
function toolVerb(name: string, category: ToolCategory | undefined): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} › ${mcp[2]}`;
  if (isAgentToolName(name)) return 'Agent';
  const normalized = name.toLowerCase().replace(/[^a-z]/g, '');
  switch (category) {
    case 'run': return '$';
    case 'read': return 'Read';
    case 'edit': return /write|create/.test(normalized) ? 'Write' : 'Edit';
    case 'search':
      if (/glob|findfiles/.test(normalized)) return 'Glob';
      if (/^(grep|rg|ripgrep)$/.test(normalized)) return 'Grep';
      if (/^(ls|list|listdir|listfiles|listdirectory)$/.test(normalized)) return 'List';
      return 'Search';
    case 'fetch': return /search/.test(normalized) ? 'Web search' : 'Fetch';
    default: return name;
  }
}

/** Short `key=value` summary of a call's arguments, for a tool whose input
 * has no single target (an MCP tool's). Strings first, each clipped. */
export function argumentSummary(input?: Record<string, unknown>, max = 60): string | undefined {
  const parts = Object.entries(input ?? {}).flatMap(([key, value]) => {
    if (value === undefined || value === null || value === '') return [];
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : JSON.stringify(value);
    return text ? [`${key}=${text.length > 24 ? `${text.slice(0, 23)}…` : text}`] : [];
  });
  const joined = parts.join(' ');
  return joined ? (joined.length > max ? `${joined.slice(0, max - 1)}…` : joined) : undefined;
}

/** A call's command as one line: vendors send it as a string or as argv. */
export function commandText(command: unknown): string | undefined {
  if (typeof command === 'string') return command;
  return Array.isArray(command) ? command.map(String).join(' ') : undefined;
}

export function toolLabel(name: string, input?: Record<string, unknown>, category?: ToolCategory): string {
  // Matched with separators and case removed, the same way tool NAMES are
  // below, because vendors disagree about spelling far more than about
  // meaning: Antigravity writes CommandLine and AbsolutePath where others
  // write command and file_path. Comparing the normalised form covers those
  // without a per-vendor table, and covers the next vendor's spelling too.
  const WANTED = ['filepath', 'path', 'notebookpath', 'absolutepath', 'command', 'commandline',
    'pattern', 'query', 'url'];
  const normalise = (key: string): string => key.replace(/[\s_-]/g, '').toLowerCase();
  const pick = (keys: readonly string[]) => keys
    .map((wanted) => Object.entries(input ?? {}).find(([key]) => normalise(key) === wanted)?.[1])
    .map((value) => Array.isArray(value) && value.every((part) => typeof part === 'string') ? value.join(' ') : value)
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  const kind = category ?? toolCategory(name, input);
  const target = pick(WANTED);
  if (target) return formatToolRow(name, target, kind);
  // A sub-agent's row is the task, not the bare tool name. These keys are
  // not targets for any other tool: a command still wins above, and a tool
  // that is not an agent never reads them.
  if (isAgentToolName(name)) return formatToolRow(name, pick(['description', 'task', 'prompt', 'instructions']), kind);
  // An MCP tool's input has no single target; a short summary says which call it was.
  return formatToolRow(name, name.startsWith('mcp__') ? argumentSummary(input) : undefined, kind);
}

/** Tool names that mean "a sub-agent is working", with separators and case
 * removed. A shell command is not one of these: callers that already know
 * the call is a `run` must not ask. */
export function isAgentToolName(name: string): boolean {
  // The name, or a row's first word (`Agent review the tests`, `Task(review)`).
  const normalized = name.split(/[\s(]/, 1)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  return /^(task|agent|subagent|delegate|spawn|spawnagent|followuptask|collabagent|launchagent|runagent)$/.test(normalized)
    || normalized.endsWith('subagent');
}

/** Vendors do not agree on tool names, but they agree on verbs. Matched
 * against the name with separators and case removed, so `str_replace_editor`,
 * `strReplaceEditor` and `STR-REPLACE-EDITOR` are one entry. Web surfaces come
 * first: a `web_search` is a fetch, not a repository search. */
const TOOL_NAME_CATEGORIES: ReadonlyArray<readonly [ToolCategory, RegExp]> = [
  ['fetch', /^(webfetch|websearch|webbrowse|webread|browse|curl|httpget|http|fetchurl)$/],
  ['edit', /^(edit|write|patch|applypatch|strreplace|strreplaceeditor|multiedit|createfile|updatefile|writefile|filewrite|notebookedit|insert|append)$/],
  ['read', /^(read|view|open|cat|readfile|getfile|fileread|viewfile|openfile|notebookread)$/],
  ['run', /^(bash|sh|shell|exec|execute|run|runcommand|runterminalcmd|terminal|command|process|localshell)$/],
  ['search', /^(grep|glob|find|search|rg|ripgrep|listdir|ls|listfiles|codebasesearch|filesearch|searchfiles|findfiles|todoread)$/],
  ['fetch', /^(fetch|request|download)$/],
];

/** Which input key carried the target, for a tool whose name says nothing.
 * This is the vendor-agnostic half: an ACP agent advertising names nobody has
 * ever seen still classifies, because a `command` is a command everywhere. A
 * bare path is deliberately absent -- it does not say whether the file was
 * read or written, and guessing is what made the old label regex untrustworthy. */
const TOOL_INPUT_CATEGORIES: ReadonlyArray<readonly [ToolCategory, string]> = [
  ['run', 'command'], ['search', 'pattern'], ['search', 'query'], ['fetch', 'url'],
];

/** How one harness's tool calls reach a category. Every harness in the
 * catalog has an entry, including the ones that can never produce a tool row
 * at all -- "fully mapped" means the answer is written down for each of them,
 * not that each of them works.
 *
 * `names` lists only the vendor names the verb table and the input shape
 * cannot settle between them. It is deliberately short: a name invented here
 * would be a claim about a vendor's protocol that nobody has checked, which is
 * the failure mode the old label regex was. Where a harness needs no entries,
 * `note` says what classifies it instead.
 */
interface HarnessToolMapping {
  /** `text` harnesses emit no machine-readable tool events at all, so no
   * category is reachable for them -- a ceiling in the vendor's CLI, not here. */
  stream: 'structured' | 'text';
  names?: Readonly<Record<string, ToolCategory>>;
  note: string;
}

export const CLAUDE_TOOL_NAMES: Readonly<Record<string, ToolCategory>> = {
  // Read/Edit/Write/Bash/Glob/Grep/WebFetch/NotebookRead/NotebookEdit all
  // match the verb table already. These two are the background-shell tools it
  // cannot reach, and they carry no input that would classify them either.
  BashOutput: 'run', KillShell: 'run',
};

/** ClikCode's own agent loop, the one the gateway route runs on this machine.
 * It is not a vendor CLI and so not in the catalog, but it is a harness that
 * emits tool events, and leaving it out of the map would be the same silent
 * absence the map exists to prevent. */
export const GATEWAY_HARNESS_COMMAND = 'gateway';

export const HARNESS_TOOL_MAPPINGS: Readonly<Record<string, HarnessToolMapping>> = {
  claude: { stream: 'structured', names: CLAUDE_TOOL_NAMES, note: 'tool_use blocks carry name and input; Edit/Write also carry a diff, which settles them outright.' },
  qwen: { stream: 'structured', names: CLAUDE_TOOL_NAMES, note: 'Claude-shaped stream, parsed by the same branch and named the same way.' },
  grok: { stream: 'structured', names: CLAUDE_TOOL_NAMES, note: 'Claude-shaped stream, confirmed live from its own init line, so the same branch reads it.' },
  gemini: { stream: 'structured', names: CLAUDE_TOOL_NAMES, note: 'stream-json in the Claude shape; its ACP mode is a flag, not a subcommand.' },
  codex: { stream: 'structured', note: 'command_execution is a run by the shape of its own envelope; mcp_tool_call classifies by the MCP tool name.' },
  opencode: { stream: 'structured', note: 'part.tool with part.state.input: the verb table reads the name, the input shape covers the rest.' },
  kilo: { stream: 'structured', note: 'an OpenCode fork emitting the same envelope.' },
  goose: { stream: 'structured', note: 'names are server-prefixed (developer__shell), which no verb table can match; the command in their input is what classifies them.' },
  cline: { stream: 'structured', note: 'ACP toolRequest carries name and arguments.' },
  droid: { stream: 'structured', note: 'ACP toolRequest carries name and arguments.' },
  kiro: { stream: 'structured', note: 'ACP toolRequest carries name and arguments.' },
  amp: { stream: 'structured', names: CLAUDE_TOOL_NAMES, note: 'declares the Claude stream (`claude-stream-json`), so its tools are named the Claude way; this row said "classify by name where the stream reports one" and left them to the generic verb table.' },
  pi: { stream: 'structured', note: 'JSON-lines turn; tool events classify by name where the stream reports one.' },
  antigravity: { stream: 'structured', note: 'step_update carries tool_name AND tool_info.parameters (CommandLine on run_command, AbsolutePath on view_file), verified against agy 1.2.7. An earlier note here claimed there was no input, which is why every tool row read as a bare name.' },
  cursor: { stream: 'structured', note: 'tool events carry a name and a description, not an input record; the verb table alone classifies them.' },
  command: { stream: 'structured', note: 'tool_running/tool_completed/tool_errored carry toolName; shell and edit both match the verb table.' },
  dcode: { stream: 'structured', note: 'ACP tool updates carry the operation and input; vendor-specific names have not been verified live.' },
  devin: { stream: 'structured', note: 'ACP tool updates carry the operation and input; vendor-specific names have not been verified live.' },
  junie: { stream: 'structured', note: 'ACP tool updates carry the operation and input; vendor-specific names have not been verified live.' },
  mcode: { stream: 'structured', note: 'ACP tool updates carry the operation and input; vendor-specific names have not been verified live.' },
  auggie: { stream: 'structured', note: 'JSON turn; ACP tool events classify by name.' },
  copilot: { stream: 'text', note: 'text-only turn output. ACP is declared for session identity, not for a tool stream, so no tool row is reachable.' },
  aider: { stream: 'text', note: 'text-only turn output; the vendor CLI publishes no machine-readable tool events.' },
  hermes: { stream: 'structured', note: 'the turn is `hermes acp`, which emits tool_call updates (terminal is execute, delegate_task is the sub-agent). `chat --quiet` is the text fallback and has no tool events.' },
  openclaw: { stream: 'text', note: 'agent --local --json is one envelope (`final`) after the turn. Tool streaming exists only on `openclaw acp`, which requires a running Gateway and is not this turn.' },
  kimi: { stream: 'structured', note: 'its CLI turn emits stream-json, and its ACP surface is a subcommand rather than a flag.' },
  vibe: { stream: 'structured', note: '--output streaming is newline-delimited JSON per message; vibe-acp is a separate binary.' },
  openhands: { stream: 'structured', note: '--json streams JSONL events in headless mode; `acp` is a subcommand.' },
  cn: { stream: 'text', note: 'text-only turn output; the vendor CLI publishes no machine-readable tool events.' },
  [GATEWAY_HARNESS_COMMAND]: {
    stream: 'structured',
    // read_file/list_dir/glob/grep/write_file/edit_file/multi_edit/bash/
    // web_fetch all match the verb table. These two are the background-shell
    // pair it cannot reach; todo_write and exit_plan_mode stay unclassified
    // because neither is work on the user's code.
    names: { bash_output: 'run', kill_bash: 'run' },
    note: "ClikCode's own loop: the tool name is ours, so the verb table settles all but the background-shell pair.",
  },
};

/** Spread form: contributes nothing at all when the evidence does not settle
 * it, so an unclassified tool's event is byte-identical to what it was before
 * categories existed. */
export function categoryOf(name: string, input?: Record<string, unknown>, harness?: string): { category?: ToolCategory } {
  const category = toolCategory(name, input, false, harness);
  return category ? { category } : {};
}

/** What a tool call does, from evidence, in order of how much it proves:
 * a diff the harness actually reported, then the tool's own name, then the
 * shape of its input. Undefined when none of the three settles it. */
export function toolCategory(
  name: string, input?: Record<string, unknown>, hasDiff = false, harness?: string,
): ToolCategory | undefined {
  if (hasDiff) return 'edit';
  const declared = harness ? HARNESS_TOOL_MAPPINGS[harness]?.names?.[name] : undefined;
  if (declared) return declared;
  const normalized = name.toLowerCase().replace(/[^a-z]/g, '');
  for (const [category, pattern] of TOOL_NAME_CATEGORIES) if (pattern.test(normalized)) return category;
  for (const [category, key] of TOOL_INPUT_CATEGORIES) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) return category;
  }
  return undefined;
}

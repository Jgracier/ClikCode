/** Naming and categorizing a tool call, per harness. A category decides how
 * the call is painted, so an unmapped tool must still land somewhere sane. */

import { visibleSlice } from '../../tui/render/width.js';
import type { ToolCategory } from '../prompter.js';

/** `Edit(src/app.ts)` rather than a bare `Edit`. The tool name alone says
 * nothing about what was touched; every vendor carries the target in the
 * call's input under one of a few well-known keys. */
/** The one place that decides what a tool row looks like.
 *
 * Every harness's parser funnels through here so the shape, the first-line
 * rule and the width cap are identical no matter which vendor produced the
 * event. They had drifted into four shapes -- `name(detail)`, a bare detail
 * with no name, `name` alone, and a hand-built `name(description)` that
 * repeated this formatting inline -- so the same action looked different
 * depending on which harness ran it.
 *
 * A detail that adds nothing is dropped rather than padded: a tool whose only
 * parameters are an opaque id reads better as its bare name than as
 * `name(some-uuid)`. */
export function formatToolRow(name: string, detail?: string): string {
  const firstLine = detail?.split(/\r?\n/, 1)[0]?.trim();
  return firstLine ? `${name}(${visibleSlice(firstLine, 72)})` : name;
}

export function toolLabel(name: string, input?: Record<string, unknown>): string {
  // Matched with separators and case removed, the same way tool NAMES are
  // below, because vendors disagree about spelling far more than about
  // meaning: Antigravity writes CommandLine and AbsolutePath where others
  // write command and file_path. Comparing the normalised form covers those
  // without a per-vendor table, and covers the next vendor's spelling too.
  const WANTED = ['filepath', 'path', 'notebookpath', 'absolutepath', 'command', 'commandline',
    'pattern', 'query', 'url'];
  const normalise = (key: string): string => key.replace(/[\s_-]/g, '').toLowerCase();
  const target = WANTED
    .map((wanted) => Object.entries(input ?? {}).find(([key]) => normalise(key) === wanted)?.[1])
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  return formatToolRow(name, target);
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
export const GATEWAY_HARNESS_COMMAND = 'clikdeploy-gateway';

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
  auggie: { stream: 'structured', note: 'JSON turn; ACP tool events classify by name.' },
  copilot: { stream: 'text', note: 'text-only turn output. ACP is declared for session identity, not for a tool stream, so no tool row is reachable.' },
  aider: { stream: 'text', note: 'text-only turn output; the vendor CLI publishes no machine-readable tool events.' },
  hermes: { stream: 'text', note: 'text-only turn output; its ACP surface is session-level, not a tool stream.' },
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

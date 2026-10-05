/** Grok Build: `<GROK_HOME or ~/.grok>/sessions/<url-encoded cwd>/<id>/`.
 *
 * A session is a directory of about a dozen files (summary.json,
 * chat_history.jsonl, updates.jsonl, events.jsonl, system_prompt.txt,
 * prompt_context.json, tool_definitions.json, signals.json, ...). Grok's own
 * docs call updates.jsonl "the authoritative conversation log" -- but that is
 * the ACP update stream a client REPLAYS. What the model is sent on resume
 * is chat_history.jsonl, and the session is found through summary.json.
 * Observed against a logging stub endpoint (vendor-sandbox, grok 1.0.46):
 *
 *   - chat_history.jsonl alone, or updates.jsonl alone: `session/load` fails
 *     "Path not found".
 *   - chat_history.jsonl + summary.json: loads (ACP `session/load` and CLI
 *     `--resume`), and the next request carries every message of
 *     chat_history in order -- assistant `tool_calls` and `tool_result`
 *     lines as OpenAI tool calls and tool messages. Grok renders the system
 *     prompt afresh for every request; only the `<user_info>` preamble it
 *     wrote at session start lives in the history.
 *   - summary.json needs `info`, `session_summary`, `created_at`,
 *     `updated_at`, `num_messages` and `current_model_id` (each missing one
 *     fails the load naming it); an unknown model id falls back to Grok's
 *     default model.
 *   - updates.jsonl absent: the ACP replay is empty, which ClikCode ignores
 *     (acp-client.ts drops every update before its own prompt).
 *
 * Grok shares one store between its ACP agent and its CLI
 * (`acp.sharedSessions`), so a written thread is not pinned to either.
 */

import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore, type NativeThreadWriter } from '../stores.js';
import {
  absolutePath, assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText,
  sequentialIds, testedVersion,
} from './thread-writer-files.js';
import { writeDirectoryAtomic } from './thread-writer-directory.js';

function grokRoot(environment: NativeSessionEnvironment): string {
  const home = environment.GROK_HOME?.trim() || join(nativeDataRoot(environment, 'HOME', homedir()), '.grok');
  return join(home, 'sessions');
}

/** Grok's group directory for a cwd: every byte but `A-Za-z0-9-._~`
 *  percent-encoded. Observed: `/var/tmp/wprobe/w s+@~%é_.-x(1)` ->
 *  `%2Fvar%2Ftmp%2Fwprobe%2Fw%20s%2B%40~%25%C3%A9_.-x%281%29` (unlike
 *  encodeURIComponent, the parentheses are encoded too). Undefined past 255
 *  bytes, where Grok switches to a slug + hash + `.cwd` file this writer
 *  does not reproduce. */
export function grokWorkspaceDirectoryName(workspace: string): string | undefined {
  const name = encodeURIComponent(workspace).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return Buffer.byteLength(name) <= 255 ? name : undefined;
}

/** Grok's own tool for a call (the tool_definitions.json Grok 1.0.46 sends):
 *  run_terminal_command, read_file, search_replace, write, grep, list_dir,
 *  web_search. Anything else -- a glob, a URL fetch, an MCP call, an edit
 *  whose old/new text was not recorded -- is told as text. */
function grokCall(workspace: string) {
  return (call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined => {
    const name = call.name.toLowerCase();
    const path = callPath(call);
    const file = path ? absolutePath(workspace, path) : undefined;
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command|run_terminal_command)$/.test(name))) {
      const command = callCommand(call);
      return command ? { name: 'run_terminal_command', args: { command, description: 'Run a shell command' } } : undefined;
    }
    if (call.category === 'read' && file) return { name: 'read_file', args: { target_file: file } };
    if (call.category === 'edit' && file) {
      if (isWriteCall(call)) {
        const content = inputString(call, 'content', 'file_text', 'text');
        return content !== undefined ? { name: 'write', args: { file_path: file, content } } : undefined;
      }
      const oldString = inputString(call, 'old_string', 'oldText', 'old_str');
      const newString = inputString(call, 'new_string', 'newText', 'new_str');
      return oldString !== undefined && newString !== undefined
        ? { name: 'search_replace', args: { file_path: file, old_string: oldString, new_string: newString } } : undefined;
    }
    if (call.category === 'search') {
      if (/^(list|ls|list_dir|list_directory)$/.test(name)) {
        const directory = inputString(call, 'path', 'target_directory', 'dir_path', 'directory') ?? call.target;
        return directory ? { name: 'list_dir', args: { target_directory: absolutePath(workspace, directory) } } : undefined;
      }
      if (/glob|find/.test(name)) return undefined;
      const pattern = inputString(call, 'pattern', 'query', 'regex') ?? call.target;
      if (!pattern) return undefined;
      const where = inputString(call, 'path', 'dir_path', 'directory');
      return { name: 'grep', args: { pattern, ...(where ? { path: absolutePath(workspace, where) } : {}) } };
    }
    if (call.category === 'fetch' && !inputString(call, 'url', 'uri')) {
      const query = inputString(call, 'query', 'q') ?? call.target;
      return query ? { name: 'web_search', args: { query } } : undefined;
    }
    return undefined;
  };
}

export interface GrokThreadOptions {
  sessionId: string;
  workspace: string;
  model: string | null;
  now: Date;
  /** `OS Version` and `Shell` of the `<user_info>` preamble. */
  platform?: string;
  shell?: string;
  callId?: () => string;
}

/** The local calendar date, as Grok's `Today's date`. */
function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** chat_history.jsonl and summary.json as Grok 1.0.46 writes them.
 *
 *  The history opens with the `<user_info>` block Grok itself writes as a
 *  session's first message (OS, shell, workspace, date) -- its system prompt
 *  is rebuilt on every request, but this block is not, so a written thread
 *  without it would leave the model not knowing its workspace. The `<rules>`
 *  section Grok renders into that block from its settings is not
 *  reproduced. Each request is wrapped in `<user_query>` as Grok wraps one;
 *  each answer is `assistant` lines (text, `tool_calls` with JSON-string
 *  arguments) followed by one `tool_result` per call. */
export function grokThreadFiles(record: CanonicalRecord, options: GrokThreadOptions): { chatHistory: string; summary: string } {
  const callId = options.callId ?? sequentialIds('call-clikcode-');
  const map = grokCall(options.workspace);
  const model = options.model ?? 'grok-build';
  const lines: unknown[] = [{
    type: 'user',
    content: [{ type: 'text', text: `<user_info>\nOS Version: ${options.platform ?? process.platform}\nShell: ${options.shell ?? process.env.SHELL ?? '/bin/sh'}\nWorkspace Path: ${options.workspace}\nToday's date: ${localDate(options.now)}\n</user_info>` }],
  }];
  let prompts = 0;
  let chat = 0;
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !prompts) {
      lines.push({ type: 'user', content: [{ type: 'text', text: `<user_query>\n${request.trim() ? request : '(continue)'}\n</user_query>` }], prompt_index: prompts });
      prompts += 1;
      chat += 1;
    }
    const turnModel = turn.origin.model ?? model;
    for (const step of assistantSteps(turn, map, callId)) {
      lines.push({
        type: 'assistant', content: step.text,
        ...(step.calls.length ? { tool_calls: step.calls.map((call) => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.args) })) } : {}),
        model_id: turnModel,
      });
      chat += 1;
      for (const call of step.calls) {
        lines.push({ type: 'tool_result', tool_call_id: call.id, content: callResultText(call.call) });
        chat += 1;
      }
    }
  }
  const at = options.now.toISOString();
  const title = record.turns.find((turn) => turn.user.trim())?.user.trim().replace(/\s+/g, ' ').slice(0, 60) ?? '';
  const summary = {
    info: { id: options.sessionId, cwd: options.workspace },
    session_summary: title,
    created_at: at,
    updated_at: at,
    num_messages: lines.length,
    num_chat_messages: chat,
    current_model_id: model,
    chat_format_version: 1,
    session_kind: 'headless',
    last_active_at: at,
    ...(title ? { generated_title: title } : {}),
  };
  return {
    chatHistory: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    summary: `${JSON.stringify(summary, null, 2)}\n`,
  };
}

/** Verified against Grok Build 1.0.46 (2026-10-04, vendor-sandbox, grok-4.7):
 *  the golden conversation written here, resumed the way ClikCode resumes
 *  it -- ACP `session/load` + `session/prompt` -- answered "Codeword:
 *  PELICAN-73 / notes.txt: launch window: Thursday / Change in src/app.ts:
 *  Replaced the typo "cosnt x = 1;" with "const x = 1;"" (the Codex shell
 *  call as run_terminal_command, the Claude Edit as search_replace); and
 *  `grok -p --resume <id>` on another written thread answered "The codeword
 *  you gave me is OSPREY-58. notes.txt says the launch window is Thursday." */
export const grokThreadWriter: NativeThreadWriter = {
  testedVersions: ['1.0.46'],
  versionOk: testedVersion(['1.0.46']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const group = grokWorkspaceDirectoryName(context.workspace);
    if (!group) return undefined;
    const sessionId = randomUUID();
    const files = grokThreadFiles(record, { sessionId, workspace: context.workspace, model: context.model, now: new Date(), shell: context.environment.SHELL });
    await writeDirectoryAtomic(join(grokRoot(context.environment), group, sessionId), {
      'chat_history.jsonl': files.chatHistory,
      'summary.json': files.summary,
    });
    return { nativeId: sessionId };
  },
};

/** A session is a directory, filed under the cwd it ran in -- the
 * conversation's workspace first, then any other cwd (a chat whose folder
 * moved). Found, it is carried as a path: the whole directory, so the next
 * account resumes the vendor's own thread, every tool call included. */
async function locateGrokSession(root: string, nativeId: string, workspace: string): Promise<NativeSessionFile | undefined> {
  const isSession = (path: string): Promise<boolean> => stat(join(path, 'summary.json')).then((entry) => entry.isFile(), () => false);
  const group = grokWorkspaceDirectoryName(workspace);
  if (group && await isSession(join(root, group, nativeId))) return { path: join(root, group, nativeId), root };
  for (const other of await readdir(root).catch(() => [] as string[])) {
    if (other !== group && await isSession(join(root, other, nativeId))) return { path: join(root, other, nativeId), root };
  }
  return undefined;
}

export const grokSessionStore: NativeSessionStore = {
  root: grokRoot,
  locate: locateGrokSession,
  writer: grokThreadWriter,
};

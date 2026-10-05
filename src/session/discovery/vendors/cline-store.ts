/** Cline CLI (3.x, the Cline SDK): `<sessions>/<id>/<id>.json` +
 *  `<id>.messages.json`, where `<sessions>` is CLINE_SESSION_DATA_DIR, else
 *  `<data>/sessions` with `<data>` CLINE_DATA_DIR, else
 *  `<CLINE_DIR or ~/.cline>/data` (Cline's own resolution, read from its
 *  bundle).
 *
 * Observed against a logging stub endpoint (vendor-sandbox, cline 3.0.68):
 *
 *   - Resuming is ACP `session/load` (ClikCode's transport for Cline): the
 *     agent's `readMessages(id)` feeds `initialMessages` to a new run of the
 *     same id, and the next request carries them in order, `tool_use` and
 *     `tool_result` blocks as OpenAI tool calls and tool messages.
 *   - `<id>.messages.json` alone: "Resource not found". Adding `<id>.json`
 *     (the session record, pointing at the messages file through
 *     `messages_path`) is enough; the `sessions.db` row Cline also keeps is
 *     not consulted (a written session with no row loads, and Cline adds
 *     the row itself on the first turn).
 *   - A `tool_result` block needs the tool's `name`, or the run rejects the
 *     history as not matching its ModelMessage schema.
 *   - The system prompt is rebuilt for the session (`buildConfig`), so the
 *     `system_prompt` a native file carries is not written.
 *
 * The CLI cannot resume one: `cline --id <id>` forces the interactive TUI
 * and refuses `--json` ("JSON output mode requires a prompt argument"), so
 * a written thread is pinned to ACP.
 * A session is one directory, flat under `<sessions>`. Carried to another
 * account it still names the first account's files: a resume reads and
 * appends to the record's `messages_path` (and `compaction_path`) before the
 * path it would derive (`U.messages_path || l` in @cline/core), so the copy's
 * record is pointed at the copy's own files (reconcile).
 */

import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore, type NativeThreadWriter } from '../stores.js';
import {
  absolutePath, assistantSteps, callCommand, callPath, callResultText, inputString, requestText, sequentialIds, testedVersion,
  writeFileAtomic,
} from './thread-writer-files.js';
import { writeDirectoryAtomic } from './thread-writer-directory.js';

function clineRoot(environment: NativeSessionEnvironment): string {
  const sessions = environment.CLINE_SESSION_DATA_DIR?.trim();
  if (sessions) return sessions;
  const data = environment.CLINE_DATA_DIR?.trim()
    || join(environment.CLINE_DIR?.trim() || join(nativeDataRoot(environment, 'HOME', homedir()), '.cline'), 'data');
  return join(data, 'sessions');
}

/** One session's directory: the path the writer writes and locate looks
 *  for. It holds `<id>.json` (the record) and `<id>.messages.json`. */
function clineSessionDirectory(root: string, sessionId: string): string {
  return join(root, sessionId);
}

/** A session id as Cline makes one: `<epoch ms>_<5 of [a-z0-9]>`. */
function clineSessionId(now: Date): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const suffix = [...randomBytes(5)].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `${now.getTime()}_${suffix}`;
}

/** Cline's own tool for a call (the tools Cline 3.0.68 sends):
 *  run_commands, read_files, search_codebase, and apply_patch for a call
 *  that recorded a patch in apply_patch's grammar. Anything else -- an edit
 *  recorded as old/new strings (Cline's edit tool differs by model), a
 *  fetch, an MCP call -- is told as text. */
function clineCall(workspace: string) {
  return (call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined => {
    const name = call.name.toLowerCase();
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command|run_commands)$/.test(name))) {
      const command = callCommand(call);
      return command ? { name: 'run_commands', args: { commands: [command] } } : undefined;
    }
    const path = callPath(call);
    if (call.category === 'read' && path) return { name: 'read_files', args: { files: [{ path: absolutePath(workspace, path) }] } };
    if (call.category === 'search' && !/^(list|ls|list_dir|list_directory|glob)$/.test(name)) {
      const pattern = inputString(call, 'pattern', 'query', 'regex') ?? call.target;
      return pattern ? { name: 'search_codebase', args: { queries: [pattern] } } : undefined;
    }
    if (call.category === 'edit') {
      const patch = inputString(call, 'input', 'patch');
      return patch?.trimStart().startsWith('*** Begin Patch') ? { name: 'apply_patch', args: { input: patch } } : undefined;
    }
    return undefined;
  };
}

export interface ClineThreadOptions {
  sessionId: string;
  workspace: string;
  model: string | null;
  /** Cline's provider id for the session record (`cline`, `openai-compatible`). */
  provider?: string;
  now: Date;
  /** Absolute path of the messages file, as the session record names it. */
  messagesPath: string;
  callId?: () => string;
  messageId?: () => string;
}

/** `<id>.messages.json` and `<id>.json` as Cline 3.0.68 writes them: the
 *  messages Anthropic-shaped (`tool_use` in the assistant message,
 *  `tool_result` with the tool's name in the next user message), requests
 *  wrapped in the `<user_input mode="act">` Cline wraps them in. */
export function clineThreadFiles(record: CanonicalRecord, options: ClineThreadOptions): { messages: string; session: string } {
  const callId = options.callId ?? sequentialIds('toolu_clikcode_');
  const messageId = options.messageId ?? sequentialIds('msg_clikcode_');
  const map = clineCall(options.workspace);
  const start = options.now.getTime();
  let tick = 0;
  const messages: Array<Record<string, unknown>> = [];
  const push = (role: 'user' | 'assistant', content: unknown[]): void => {
    messages.push({ id: messageId(), role, content, ts: start + tick });
    tick += 1;
  };
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !messages.length) {
      push('user', [{ type: 'text', text: `<user_input mode="act">${request.trim() ? request : '(continue)'}</user_input>` }]);
    }
    for (const step of assistantSteps(turn, map, callId)) {
      push('assistant', [
        ...(step.text ? [{ type: 'text', text: step.text }] : []),
        ...step.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })),
      ]);
      if (step.calls.length) {
        push('user', step.calls.map((call) => ({ type: 'tool_result', tool_use_id: call.id, name: call.name, content: callResultText(call.call) })));
      }
    }
  }
  const at = new Date(start).toISOString();
  const title = record.turns.find((turn) => turn.user.trim())?.user.trim() ?? '';
  const session = {
    version: 1,
    session_id: options.sessionId,
    source: 'cli',
    pid: 0,
    started_at: at,
    ended_at: at,
    exit_code: 0,
    status: 'completed',
    interactive: false,
    provider: options.provider ?? 'cline',
    // Never empty: a record with `model: ""` is "Resource not found".
    model: options.model || record.turns.at(-1)?.origin.model || 'unknown',
    cwd: options.workspace,
    workspace_root: options.workspace,
    enable_tools: true,
    enable_spawn: true,
    enable_teams: false,
    prompt: title,
    metadata: { title: title.replace(/\s+/g, ' ').slice(0, 120) },
    messages_path: options.messagesPath,
  };
  return {
    messages: `${JSON.stringify({ version: 1, updated_at: at, agent: 'lead', sessionId: options.sessionId, messages }, null, 2)}\n`,
    session: `${JSON.stringify(session, null, 2)}\n`,
  };
}

/** Verified against Cline CLI 3.0.68 (2026-10-04, vendor-sandbox, Cline
 *  account, google/gemini-2.5-flash-lite): the golden conversation written
 *  here, resumed the way ClikCode resumes it -- ACP `session/load` +
 *  `session/prompt` -- answered "The codeword you gave me was HERON-31.
 *  notes.txt said "launch window: Thursday". The change made in src/app.ts
 *  was fixing a typo, changing "cosnt" to "const"." (the Codex shell call as
 *  run_commands; the Claude Edit, which has no Cline equivalent, as text). */
export const clineThreadWriter: NativeThreadWriter = {
  testedVersions: ['3.0.68'],
  versionOk: testedVersion(['3.0.68']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const now = new Date();
    const sessionId = clineSessionId(now);
    const directory = clineSessionDirectory(clineRoot(context.environment), sessionId);
    const messagesPath = join(directory, `${sessionId}.messages.json`);
    const files = clineThreadFiles(record, { sessionId, workspace: context.workspace, model: context.model, now, messagesPath });
    await writeDirectoryAtomic(directory, {
      [`${sessionId}.messages.json`]: files.messages,
      [`${sessionId}.json`]: files.session,
    });
    return { nativeId: sessionId, transport: 'acp' };
  },
};

/** Flat, not per workspace: the id alone places the directory, and it is a
 * session once its record is in it. */
async function locateClineSession(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
  const path = clineSessionDirectory(root, nativeId);
  return await stat(join(path, `${nativeId}.json`)).then((entry) => (entry.isFile() ? { path, root } : undefined), () => undefined);
}

/** Points a carried record's file paths at the copy (see above). A path whose
 * file is not in the copied directory is left as it was: only what was carried
 * is redirected. */
async function reconcileClineSession(input: { nativeId: string; path: string }): Promise<boolean> {
  const recordPath = join(input.path, `${input.nativeId}.json`);
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
  let changed = false;
  for (const key of ['messages_path', 'compaction_path']) {
    const named = record[key];
    if (typeof named !== 'string' || !named) continue;
    const own = join(input.path, basename(named));
    if (named === own || !await stat(own).then((entry) => entry.isFile(), () => false)) continue;
    record[key] = own;
    changed = true;
  }
  if (changed) await writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return true;
}

export const clineSessionStore: NativeSessionStore = {
  root: clineRoot,
  locate: locateClineSession,
  reconcile: reconcileClineSession,
  writer: clineThreadWriter,
};

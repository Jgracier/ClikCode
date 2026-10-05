/** Mistral Vibe: `<VIBE_HOME or ~/.vibe>/logs/session/session_<YYYYMMDD_HHMMSS>
 *  _<first 8 of id>/` holding `messages.jsonl` and `meta.json`.
 *
 * Observed (vendor-sandbox, vibe 2.25.7, a custom provider pointed at a local
 * stub that logged every request; source in vibe/core/session): a resume
 * (`--resume <id>`, ACP `session/load`) globs the directory by the id's first
 * eight characters, accepts it when meta.json's `environment.working_directory`
 * or `origin_directory` is the cwd, and sends `messages.jsonl` -- OpenAI-style
 * messages, one per line -- to the model. meta.json needs `total_messages`;
 * without `last_message_fingerprint` vibe rewrites the whole log on its next
 * save instead of appending, which is what a session it did not write wants.
 * A `session_logging.save_dir` in config.toml moves the store; that layout is
 * not written (a transfer), and a carry into it counts as failed.
 *
 * Carrying needs nothing beyond the copy: the resume finds the directory by
 * that glob, and the `.session_index.json` listing cache beside it re-reads
 * any session directory whose meta.json it has not seen
 * (SessionIndex._reconcile).
 *
 * Carry checked live against vibe 2.25.7 (2026-10-05, two VIBE_HOMEs with
 * the same Mistral key), short of the model's answer: a session started
 * over ACP in A ("Remember the word <W>. Reply OK."), carried by
 * carryNativeSession ('carried'), then `session/load` in B succeeded and
 * replayed the prompt with the word (an id never carried: "Session not
 * found"); A unchanged. Both prompts got Mistral HTTP 429 (rate_limited,
 * retried until timeout) on three different accounts, so the recall itself
 * is unproved. Retried later that day on four more FREE-plan keys and on
 * mistral-small-latest: still 429 (code 1300), and a direct API request
 * showed why -- `x-ratelimit-limit-req-minute: 0`, a key with no request
 * allowance at all, not a busy one.
 */

import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore, type NativeThreadWriter } from '../stores.js';
import {
  assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText, sequentialIds,
  testedVersion, writeFileAtomic,
} from './thread-writer-files.js';

function vibeHome(environment: NativeSessionEnvironment): string {
  return environment.VIBE_HOME?.trim() || join(environment.HOME?.trim() || homedir(), '.vibe');
}

function vibeRoot(environment: NativeSessionEnvironment): string {
  return join(vibeHome(environment), 'logs', 'session');
}

/** Whether config.toml moves the store away from vibeRoot. */
async function vibeStoreMoved(environment: NativeSessionEnvironment): Promise<boolean> {
  const config = await readFile(join(vibeHome(environment), 'config.toml'), 'utf8').catch(() => '');
  return /^\s*save_dir\s*=/m.test(config);
}

/** Vibe's own tools: bash, read_file, write_file, edit, grep, web_fetch. */
function vibeCall(call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined {
  const name = call.name.toLowerCase();
  const path = callPath(call);
  if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command)$/.test(name))) {
    const command = callCommand(call);
    return command ? { name: 'bash', args: { command } } : undefined;
  }
  if (call.category === 'read' && path) return { name: 'read_file', args: { file_path: path } };
  if (call.category === 'edit' && path) {
    if (isWriteCall(call)) return { name: 'write_file', args: { file_path: path, content: inputString(call, 'content', 'file_text', 'text') ?? '' } };
    const oldString = inputString(call, 'old_string', 'oldText', 'old_str');
    const newString = inputString(call, 'new_string', 'newText', 'new_str');
    return oldString !== undefined && newString !== undefined
      ? { name: 'edit', args: { file_path: path, old_string: oldString, new_string: newString } } : undefined;
  }
  if (call.category === 'search' && !/glob|find|list|ls/.test(name)) {
    const pattern = inputString(call, 'pattern', 'query', 'regex') ?? call.target;
    const where = inputString(call, 'path', 'dir_path', 'directory');
    return pattern ? { name: 'grep', args: { pattern, ...(where ? { path: where } : {}) } } : undefined;
  }
  if (call.category === 'fetch') {
    const url = inputString(call, 'url') ?? call.target;
    return url && /^https?:\/\//.test(url) ? { name: 'web_fetch', args: { url } } : undefined;
  }
  return undefined;
}

export interface VibeThreadOptions {
  sessionId: string;
  workspace: string;
  now: Date;
  messageId?: () => string;
}

/** `session_<stamp>_<first 8 of id>`: the stamp is the start time, so a
 *  lookup has only the rest -- all vibe's own resume globs by. */
const vibeSessionDirectoryPrefix = 'session_';
const vibeSessionDirectorySuffix = (sessionId: string): string => `_${sessionId.slice(0, 8)}`;

/** `session_20261005_035254_c148cd9a`, as vibe names a session (UTC). */
export function vibeSessionDirectoryName(sessionId: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/-|:/g, '').replace('T', '_');
  return `${vibeSessionDirectoryPrefix}${stamp}${vibeSessionDirectorySuffix(sessionId)}`;
}

/** `messages.jsonl` and `meta.json` as vibe 2.25 writes them. */
export function vibeThreadFiles(record: CanonicalRecord, options: VibeThreadOptions): { messages: string; meta: string } {
  const messageId = options.messageId ?? randomUUID;
  const callId = sequentialIds('call_clikcode_');
  const lines: Record<string, unknown>[] = [];
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !lines.length) {
      lines.push({ role: 'user', content: request.trim() ? request : '(continue)', injected: false, message_id: messageId() });
    }
    for (const step of assistantSteps(turn, vibeCall, callId)) {
      lines.push({
        role: 'assistant', ...(step.text ? { content: step.text } : {}), injected: false,
        ...(step.calls.length ? {
          tool_calls: step.calls.map((call, index) => ({
            id: call.id, index, function: { name: call.name, arguments: JSON.stringify(call.args) }, type: 'function',
          })),
        } : {}),
        message_id: messageId(),
      });
      for (const call of step.calls) {
        lines.push({ role: 'tool', content: callResultText(call.call), injected: false, name: call.name, tool_call_id: call.id });
      }
    }
  }
  const at = options.now.toISOString();
  const meta = {
    session_id: options.sessionId, parent_session_id: null, start_time: at, end_time: at, git_commit: null, git_branch: null,
    environment: { working_directory: options.workspace }, origin_directory: options.workspace, username: '',
    child_sessions: [], loops: [], title: null, title_source: 'auto', bumped_at: at, pinned_at: null,
    total_messages: lines.length,
  };
  return {
    messages: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    meta: `${JSON.stringify(meta, null, 2)}\n`,
  };
}

/** Verified against vibe 2.25.7: see the module comment; live proof in the
 *  commit that added this. */
export const vibeThreadWriter: NativeThreadWriter = {
  testedVersions: ['2.25.7'],
  versionOk: testedVersion(['2.25.7']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    if (await vibeStoreMoved(context.environment)) return undefined;
    const sessionId = randomUUID();
    const now = new Date();
    const directory = join(vibeRoot(context.environment), vibeSessionDirectoryName(sessionId, now));
    const files = vibeThreadFiles(record, { sessionId, workspace: context.workspace, now });
    try {
      // The log first: meta.json is what makes the directory a session.
      await writeFileAtomic(join(directory, 'messages.jsonl'), files.messages);
      await writeFileAtomic(join(directory, 'meta.json'), files.meta);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { nativeId: sessionId };
  },
};

/** A session is a directory named for its start time and short id, flat, not
 * per workspace; of the directories the short id matches, the one whose
 * meta.json names the whole id. Carried whole. */
async function locateVibeSession(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith(vibeSessionDirectoryPrefix) || !name.endsWith(vibeSessionDirectorySuffix(nativeId))) continue;
    const meta = await readFile(join(root, name, 'meta.json'), 'utf8').then((text) => JSON.parse(text) as unknown, () => undefined);
    if ((meta as { session_id?: unknown } | undefined)?.session_id === nativeId) return { path: join(root, name), root };
  }
  return undefined;
}

export const vibeSessionStore: NativeSessionStore = {
  root: vibeRoot,
  locate: locateVibeSession,
  // Only a resumable copy counts: an account whose config moved the store
  // would never look where the copy went.
  reconcile: async ({ environment }) => !await vibeStoreMoved(environment),
  writer: vibeThreadWriter,
};

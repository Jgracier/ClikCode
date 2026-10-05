/** Kimi Code CLI (2.x): `<KIMI_CODE_HOME or ~/.kimi-code>/sessions/
 *  wd_<slug>_<hash12>/session_<uuid>/` holding `state.json` and
 *  `agents/main/wire.jsonl`.
 *
 * wire.jsonl is an event log, and the conversation the model is sent is
 * rebuilt from its `context.append_message` (user messages) and
 * `context.append_loop_event` records (`step.begin`, `content.part`,
 * `tool.call`, `tool.result`, `step.end`). Observed against a logging stub
 * endpoint (vendor-sandbox, kimi 2.0.2):
 *
 *   - state.json is what makes the session exist: without it ACP
 *     `session/load` answers "Unknown sessionId". The index files
 *     (session_index.jsonl, sessions/.index-cache, workspaces.json) are not
 *     needed; Kimi repairs them itself.
 *   - Loop events without their `step.begin`/`step.end` are dropped: the
 *     model then saw only the user message.
 *   - No `profile.bind` record: on load over ACP Kimi binds the session to
 *     its current profile and renders a fresh system prompt (with today's
 *     AGENTS.md), which is what a taken-up thread wants. Writing a bind would
 *     need Kimi's whole rendered system prompt, and a `config.update` naming
 *     only a model makes it send NO system prompt at all. Without either,
 *     `kimi --session <id> -p` needs `-m` ("Model not set"), so the thread is
 *     pinned to ACP.
 */

import { createHash, randomUUID } from 'node:crypto';
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

function kimiHome(environment: NativeSessionEnvironment): string {
  return environment.KIMI_CODE_HOME?.trim() || join(nativeDataRoot(environment, 'HOME', homedir()), '.kimi-code');
}

function kimiRoot(environment: NativeSessionEnvironment): string {
  return join(kimiHome(environment), 'sessions');
}

/** Kimi's bucket for a workdir (agent-core-v2 encodeWorkDirKey):
 *  `wd_<slug of the last path segment, <= 40>_<sha256(path)[:12]>`.
 *  Observed: /var/tmp/wprobe/kmws -> `wd_kmws_c5c6e3059ec1`. */
export function kimiWorkDirKey(workDir: string): string {
  const normalized = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const trim = (value: string): string => value.replace(/^-+|-+$/g, '');
  const slug = trim(trim((normalized.split('/').pop() ?? normalized).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')).slice(0, 40));
  const name = slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
  return `wd_${name}_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

/** One session's directory, under a workdir bucket: the path the writer
 *  writes and locate looks for. */
function kimiSessionDirectory(root: string, workDirKey: string, sessionId: string): string {
  return join(root, workDirKey, sessionId);
}

/** Kimi's own tool for a call (the tool snapshot Kimi 2.0.2 sends): Bash,
 *  Read, Write, Edit, Grep, Glob, FetchURL, WebSearch. Anything else -- an
 *  MCP call, an edit whose old/new text was not recorded -- is told as
 *  text. */
function kimiCall(workspace: string) {
  return (call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined => {
    const name = call.name.toLowerCase();
    const path = callPath(call);
    const file = path ? absolutePath(workspace, path) : undefined;
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command)$/.test(name))) {
      const command = callCommand(call);
      return command ? { name: 'Bash', args: { command } } : undefined;
    }
    if (call.category === 'read' && file) return { name: 'Read', args: { path: file } };
    if (call.category === 'edit' && file) {
      if (isWriteCall(call)) {
        const content = inputString(call, 'content', 'file_text', 'text');
        return content !== undefined ? { name: 'Write', args: { path: file, content } } : undefined;
      }
      const oldString = inputString(call, 'old_string', 'oldText', 'old_str');
      const newString = inputString(call, 'new_string', 'newText', 'new_str');
      return oldString !== undefined && newString !== undefined
        ? { name: 'Edit', args: { path: file, old_string: oldString, new_string: newString } } : undefined;
    }
    if (call.category === 'search') {
      const pattern = inputString(call, 'pattern', 'query', 'regex') ?? call.target;
      if (!pattern) return undefined;
      const where = inputString(call, 'path', 'dir_path', 'directory');
      return { name: /glob|find/.test(name) ? 'Glob' : 'Grep', args: { pattern, ...(where ? { path: absolutePath(workspace, where) } : {}) } };
    }
    if (call.category === 'fetch') {
      const url = inputString(call, 'url', 'uri');
      if (url) return { name: 'FetchURL', args: { url } };
      const query = inputString(call, 'query', 'q') ?? call.target;
      return query ? { name: 'WebSearch', args: { query } } : undefined;
    }
    return undefined;
  };
}

export interface KimiThreadOptions {
  sessionId: string;
  workspace: string;
  /** The session directory, as state.json records it. */
  directory: string;
  now: Date;
  uuid?: () => string;
  callId?: () => string;
}

/** wire.jsonl and state.json as Kimi 2.0.2 writes them: per turn, the
 *  request as a `context.append_message`, then each model response as a
 *  step -- `step.begin`, its text as a `content.part`, its calls as
 *  `tool.call`, their results as `tool.result` (`isError` for a failed or
 *  unfinished call), `step.end`. */
export function kimiThreadFiles(record: CanonicalRecord, options: KimiThreadOptions): { wire: string; state: string } {
  const uuid = options.uuid ?? randomUUID;
  const callId = options.callId ?? sequentialIds('call_clikcode_');
  const map = kimiCall(options.workspace);
  const time = options.now.getTime();
  const events: unknown[] = [{ type: 'metadata', protocol_version: '1.5', created_at: time }];
  const loop = (event: Record<string, unknown>): void => {
    events.push({ type: 'context.append_loop_event', agentId: 'main', event, time });
  };
  record.turns.forEach((turn, index) => {
    const turnId = String(index);
    const request = requestText(turn);
    if (request.trim() || index === 0) {
      events.push({
        type: 'context.append_message', agentId: 'main',
        message: { role: 'user', content: [{ type: 'text', text: request.trim() ? request : '(continue)' }], toolCalls: [], origin: { kind: 'user' } },
        time,
      });
    }
    assistantSteps(turn, map, callId).forEach((step, at) => {
      const stepUuid = uuid();
      const base = { turnId, step: at + 1 };
      loop({ type: 'step.begin', uuid: stepUuid, ...base });
      if (step.text) loop({ type: 'content.part', uuid: uuid(), ...base, stepUuid, part: { type: 'text', text: step.text } });
      const calls = step.calls.map((call) => {
        const callUuid = uuid();
        loop({ type: 'tool.call', uuid: callUuid, ...base, stepUuid, toolCallId: call.id, name: call.name, args: call.args });
        return { call, callUuid };
      });
      for (const { call, callUuid } of calls) {
        const failed = call.call.status !== 'done' || (call.call.exitCode !== undefined && call.call.exitCode !== 0);
        loop({ type: 'tool.result', parentUuid: callUuid, toolCallId: call.id, result: { output: callResultText(call.call), ...(failed ? { isError: true } : {}) } });
      }
      loop({ type: 'step.end', uuid: stepUuid, ...base, finishReason: calls.length ? 'tool_use' : 'end_turn' });
    });
  });
  const state = {
    id: options.sessionId, version: 2, cwd: options.workspace, createdAt: time, updatedAt: time, archived: false,
    agents: { main: { homedir: join(options.directory, 'agents', 'main'), type: 'main' } },
    custom: {}, lastTurnReason: 'completed', isCustomTitle: false,
  };
  return {
    wire: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    state: `${JSON.stringify(state)}\n`,
  };
}

/** Verified against Kimi Code 2.0.2 (2026-10-04, vendor-sandbox; the Kimi
 *  subscription answered 403, so the model was kimi-k2.6 through an
 *  OpenAI-compatible provider): the golden conversation written here,
 *  resumed the way ClikCode resumes it -- ACP `session/load` +
 *  `session/prompt` -- answered "Codeword: IBIS-64 / notes.txt: launch
 *  window: Thursday / src/app.ts: Changed `cosnt x = 1;` to
 *  `const x = 1;`" (the Codex shell call as Bash, the Claude Edit as Edit). */
export const kimiThreadWriter: NativeThreadWriter = {
  testedVersions: ['2.0.2'],
  versionOk: testedVersion(['2.0.2']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const sessionId = `session_${randomUUID()}`;
    const directory = kimiSessionDirectory(kimiRoot(context.environment), kimiWorkDirKey(context.workspace), sessionId);
    const files = kimiThreadFiles(record, { sessionId, workspace: context.workspace, directory, now: new Date() });
    await writeDirectoryAtomic(directory, { 'state.json': files.state, 'agents/main/wire.jsonl': files.wire });
    return { nativeId: sessionId, transport: 'acp' };
  },
};

/** A session is a directory, filed under its workdir's bucket -- the
 * conversation's workspace first, then any other bucket (a chat whose folder
 * moved) -- and is one once state.json is in it. Carried whole. Nothing needs
 * reconciling after the copy: the index files are repaired by Kimi itself (see
 * above), and the absolute `agents.<id>.homedir` in state.json is not where a
 * load reads the wire from -- agent-core-v2 derives that from its own home and
 * the session's bucket, and re-registers the agent's homedir as it runs. */
async function locateKimiSession(root: string, nativeId: string, workspace: string): Promise<NativeSessionFile | undefined> {
  const isSession = (path: string): Promise<boolean> => stat(join(path, 'state.json')).then((entry) => entry.isFile(), () => false);
  const bucket = kimiWorkDirKey(workspace);
  const others = (await readdir(root).catch(() => [] as string[])).filter((name) => name !== bucket);
  for (const key of [bucket, ...others]) {
    const path = kimiSessionDirectory(root, key, nativeId);
    if (await isSession(path)) return { path, root };
  }
  return undefined;
}

export const kimiSessionStore: NativeSessionStore = {
  root: kimiRoot,
  locate: locateKimiSession,
  writer: kimiThreadWriter,
};

/** Qwen Code: `<QWEN_HOME>/projects/<cwd-as-name>/chats/<id>.jsonl`.
 *
 * Directly observed: a turn driven against an OpenAI-compatible endpoint wrote
 * `projects/-home-user-projects-app/chats/<uuid>.jsonl`, whose
 * every line carries `sessionId` equal to that uuid -- the same id ClikCode
 * stores as nativeSessionId. The lines are uuid/parentUuid/sessionId/cwd
 * records, so the format is Claude Code's; the path is not, because of the
 * extra `chats` level.
 *
 * The cwd name is Qwen's own `sanitizeCwd` -- one deterministic name, read out
 * of its bundle rather than guessed:
 *
 *   normalizedCwd.replace(/[^a-zA-Z0-9]/g, '-')   // lowercased first on win32
 *
 * so unlike Claude Code there is no second candidate name to try. Sharing
 * claudeProjectDirectoryNames here would have been wrong in exactly the cases
 * the two rules disagree, which is any cwd holding a dot or an underscore.
 *
 * `<id>.runtime.json` sits beside the transcript and is deliberately NOT
 * carried: Qwen writes it so "external observers (terminal multiplexers, IDE
 * integrations, status daemons) can scan the same directory to find LIVE
 * sessions". Copying it would announce a session running in a profile where
 * nothing is running. The transcript alone is what resume reads.
 *
 * Verified end to end: the transcript copied under a second QWEN_HOME resumed
 * there, and Qwen replayed the original user turn and assistant reply to the
 * model rather than starting a new thread.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import {
  nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore, type NativeThreadWriter,
} from '../stores.js';
import {
  absolutePath, assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText,
  sequentialIds, testedVersion, versionNumber, writeFileAtomic,
} from './thread-writer-files.js';

/** Qwen's sanitizeCwd, from packages/core/src/config/storage.ts. */
export function qwenProjectDirectoryName(workspace: string): string {
  const normalized = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

function qwenRoot(environment: NativeSessionEnvironment): string {
  return join(nativeDataRoot(environment, 'QWEN_HOME', join(homedir(), '.qwen')), 'projects');
}

/** Qwen Code's own tool for a call (its 0.24 tool declarations):
 *  run_shell_command, read_file, edit, write_file, grep_search, glob. File
 *  tools take absolute paths. A fetch has no tool loaded by default, so it is
 *  told as text with everything else. */
function qwenCall(workspace: string) {
  return (call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined => {
    const path = callPath(call);
    const file = path ? absolutePath(workspace, path) : undefined;
    const name = call.name.toLowerCase();
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command)$/.test(name))) {
      const command = callCommand(call);
      return command ? { name: 'run_shell_command', args: { command } } : undefined;
    }
    if (call.category === 'read' && file) return { name: 'read_file', args: { file_path: file } };
    if (call.category === 'edit' && file) {
      if (isWriteCall(call)) return { name: 'write_file', args: { file_path: file, content: inputString(call, 'content', 'file_text', 'text') ?? '' } };
      const oldString = inputString(call, 'old_string', 'oldText', 'old_str');
      const newString = inputString(call, 'new_string', 'newText', 'new_str');
      return oldString !== undefined && newString !== undefined
        ? { name: 'edit', args: { file_path: file, old_string: oldString, new_string: newString } } : undefined;
    }
    if (call.category === 'search') {
      const pattern = inputString(call, 'pattern', 'query', 'regex') ?? call.target;
      if (!pattern) return undefined;
      const where = inputString(call, 'path', 'dir_path', 'directory');
      const args = { pattern, ...(where ? { path: absolutePath(workspace, where) } : {}) };
      return { name: /glob|find|list|ls/.test(name) ? 'glob' : 'grep_search', args };
    }
    return undefined;
  };
}

export interface QwenThreadOptions {
  sessionId: string;
  workspace: string;
  model: string | null;
  /** The Qwen build stamped on every record (`0.24.3`). */
  version: string;
  now: Date;
  uuid?: () => string;
}

/** The thread as Qwen Code 0.24 writes it: one record a line, each with
 *  uuid/parentUuid/sessionId/timestamp/cwd/version, the message in Gemini's
 *  Content shape (`parts`): `user` records for requests, `assistant` records
 *  (role `model`) with `functionCall` parts, and `tool_result` records whose
 *  user message holds the `functionResponse`. Qwen's own telemetry and
 *  attribution `system` records are left out: they are not conversation. */
export function qwenThreadLines(record: CanonicalRecord, options: QwenThreadOptions): string {
  const uuid = options.uuid ?? randomUUID;
  const callId = sequentialIds('call_clikcode_');
  const start = options.now.getTime();
  let tick = 0;
  const lines: unknown[] = [];
  let parentUuid: string | null = null;
  const append = (fields: Record<string, unknown>): void => {
    const ms = start + tick;
    tick += 1;
    const id = uuid();
    const { type, ...rest } = fields;
    lines.push({
      uuid: id, parentUuid, sessionId: options.sessionId, timestamp: new Date(ms).toISOString(), type,
      cwd: options.workspace, version: options.version, ...rest,
    });
    parentUuid = id;
  };
  const map = qwenCall(options.workspace);
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !parentUuid) {
      append({ type: 'user', message: { role: 'user', parts: [{ text: request.trim() ? request : '(continue)' }] } });
    }
    const model = turn.origin.model ?? options.model ?? 'unknown';
    for (const step of assistantSteps(turn, map, callId)) {
      append({
        type: 'assistant', model,
        message: {
          role: 'model',
          parts: [
            ...(step.text ? [{ text: step.text }] : []),
            ...step.calls.map((call) => ({ functionCall: { id: call.id, name: call.name, args: call.args } })),
          ],
        },
      });
      for (const call of step.calls) {
        const output = callResultText(call.call);
        const status = call.call.status === 'done' ? 'success' : 'error';
        append({
          type: 'tool_result',
          message: { role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name, response: { output } } }] },
          toolCallResult: { callId: call.id, status, resultDisplay: output },
        });
      }
    }
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** Verified against Qwen Code 0.24.3 (2026-10-04, vendor-sandbox). Over
 *  ACP (ClikCode's Qwen transport), `session/load` replayed every written
 *  message and tool call, and the next prompt (OpenAI auth on OpenRouter
 *  gemini-2.5-flash-lite) answered "The codeword to remember is PELICAN-73,
 *  and I read notes.txt and modified src/app.ts." The CLI's `--resume <id>`
 *  sent the same history to the model (checked against a local endpoint),
 *  so the thread is not pinned to either transport. */
export const qwenThreadWriter: NativeThreadWriter = {
  testedVersions: ['0.24.3'],
  versionOk: testedVersion(['0.24.3']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const sessionId = randomUUID();
    const path = join(qwenRoot(context.environment), qwenProjectDirectoryName(context.workspace), 'chats', `${sessionId}.jsonl`);
    await writeFileAtomic(path, qwenThreadLines(record, {
      sessionId, workspace: context.workspace, model: context.model, version: versionNumber(context.version) ?? '', now: new Date(),
    }));
    return { nativeId: sessionId };
  },
};

export const qwenSessionStore: NativeSessionStore = {
  root: qwenRoot,
  async locate(root: string, nativeId: string, workspace: string): Promise<NativeSessionFile | undefined> {
    const path = join(root, qwenProjectDirectoryName(workspace), 'chats', `${nativeId}.jsonl`);
    return await stat(path).then(() => ({ path, root }), () => undefined);
  },
  writer: qwenThreadWriter,
};

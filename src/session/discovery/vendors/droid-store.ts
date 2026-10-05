/** Factory Droid: `<FACTORY_HOME_OVERRIDE or ~/.factory>/sessions/<cwd, every
 *  / a dash>/<id>.jsonl`.
 *
 * Observed (vendor-sandbox, droid 0.223.0, a BYOK
 * `generic-chat-completion-api` custom model pointed at a local stub that
 * logged every request): a `session_start` line, then one `message` line per
 * message, each parented on the one before -- Anthropic-style content
 * (`text`, `tool_use`, and `tool_result` in a user message). Droid also
 * writes `<id>.settings.json` (model, autonomy, token usage) and a discovery
 * cache; a resume (`exec -s <id>`, ACP `session/resume`) needs neither and
 * sends the file's messages as history. Only `/` is replaced in the project
 * directory (`/var/tmp/W s_x.y+z` -> `-var-tmp-W s_x.y+z`).
 *
 * Any resume -- of droid's own sessions too -- needs a Factory sign-in
 * (`Failed to fetch session`, 401, signed out); a thread droid did not create
 * also logs a 404 from its cloud sync ("Session write target was not
 * found"), which does not stop the turn. */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { type NativeSessionEnvironment, type NativeSessionStore, type NativeThreadWriter } from '../stores.js';
import {
  absolutePath, assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText,
  sequentialIds, testedVersion, writeFileAtomic,
} from './thread-writer-files.js';

function droidHome(environment: NativeSessionEnvironment): string {
  return environment.FACTORY_HOME_OVERRIDE?.trim() || join(environment.HOME?.trim() || homedir(), '.factory');
}

function droidRoot(environment: NativeSessionEnvironment): string {
  return join(droidHome(environment), 'sessions');
}

/** Droid's project directory: the cwd with every `/` a dash. */
export function droidProjectDirectoryName(workspace: string): string {
  return workspace.replace(/[/\\]/g, '-');
}

/** Droid's own tools: Execute, Read, Edit, Create, Grep, Glob, LS. File
 *  tools take absolute paths. */
function droidCall(workspace: string): (call: CanonicalToolCall) => { name: string; args: Record<string, unknown> } | undefined {
  return (call) => {
    const name = call.name.toLowerCase();
    const path = callPath(call);
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|execute|run_shell_command|shell_command)$/.test(name))) {
      const command = callCommand(call);
      return command ? {
        name: 'Execute',
        args: { summary: 'Run a shell command', command, riskLevel: 'low', riskLevelReason: 'Recorded from an earlier turn' },
      } : undefined;
    }
    if (call.category === 'read' && path) return { name: 'Read', args: { file_path: absolutePath(workspace, path) } };
    if (call.category === 'edit' && path) {
      const file = absolutePath(workspace, path);
      if (isWriteCall(call)) return { name: 'Create', args: { file_path: file, content: inputString(call, 'content', 'file_text', 'text') ?? '' } };
      const oldString = inputString(call, 'old_string', 'oldText', 'old_str');
      const newString = inputString(call, 'new_string', 'newText', 'new_str');
      return oldString !== undefined && newString !== undefined
        ? { name: 'Edit', args: { file_path: file, old_str: oldString, new_str: newString } } : undefined;
    }
    if (call.category === 'search') {
      const pattern = inputString(call, 'pattern', 'query', 'regex') ?? call.target;
      if (!pattern) return undefined;
      if (/glob|find/.test(name)) return { name: 'Glob', args: { patterns: pattern } };
      const where = inputString(call, 'path', 'dir_path', 'directory');
      return { name: 'Grep', args: { pattern, ...(where ? { path: absolutePath(workspace, where) } : {}) } };
    }
    return undefined;
  };
}

export interface DroidThreadOptions {
  sessionId: string;
  workspace: string;
  now: Date;
  messageId?: () => string;
}

/** The thread as droid 0.223 writes it. */
export function droidThreadLines(record: CanonicalRecord, options: DroidThreadOptions): string {
  const messageId = options.messageId ?? randomUUID;
  const callId = sequentialIds('toolu_clikcode_');
  const start = options.now.getTime();
  let tick = 0;
  const title = record.turns.find((turn) => turn.user.trim())?.user.trim().replace(/\s+/g, ' ').slice(0, 100) ?? 'ClikCode conversation';
  const lines: unknown[] = [{
    type: 'session_start', id: options.sessionId, title, owner: '', version: 2, cwd: options.workspace, isSessionTitleManuallySet: false,
  }];
  let parentId: string | undefined;
  const append = (message: Record<string, unknown>): void => {
    const id = messageId();
    lines.push({ type: 'message', id, ...(parentId ? { parentId } : {}), timestamp: new Date(start + tick).toISOString(), message });
    tick += 1;
    parentId = id;
  };
  const map = droidCall(options.workspace);
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !parentId) append({ role: 'user', content: [{ type: 'text', text: request.trim() ? request : '(continue)' }] });
    for (const step of assistantSteps(turn, map, callId)) {
      append({
        role: 'assistant',
        content: [
          ...(step.text ? [{ type: 'text', text: step.text }] : []),
          ...step.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })),
        ],
      });
      if (step.calls.length) {
        append({
          role: 'user',
          content: step.calls.map((call) => ({
            type: 'tool_result', tool_use_id: call.id, is_error: call.call.status !== 'done', content: callResultText(call.call),
          })),
        });
      }
    }
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

export const droidThreadWriter: NativeThreadWriter = {
  testedVersions: ['0.223.0'],
  versionOk: testedVersion(['0.223.0']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const sessionId = randomUUID();
    const path = join(droidRoot(context.environment), droidProjectDirectoryName(context.workspace), `${sessionId}.jsonl`);
    await writeFileAtomic(path, droidThreadLines(record, { sessionId, workspace: context.workspace, now: new Date() }));
    return { nativeId: sessionId };
  },
};

export const droidSessionStore: NativeSessionStore = {
  root: droidRoot,
  writer: droidThreadWriter,
};

/** Command Code: `<HOME>/.commandcode/projects/<cwd-slug>/<id>.jsonl`.
 *
 * Its own bundled reference states the layout ("Sessions are stored per
 * project, keyed by a slug of the working directory") and, usefully, which of
 * the three sibling files is the conversation:
 *
 *   <id>.jsonl              the transcript itself (header + entries)
 *   <id>.checkpoints.jsonl  checkpoint snapshots for /rewind
 *   <id>.prompts.jsonl      prompt history
 *
 * Confirmed by carrying only the transcript into a second HOME and resuming
 * there: Command Code replayed the whole prior thread to the model. So the
 * checkpoints and prompt history are genuinely not part of resuming, and this
 * stays a one-file carry -- unlike Copilot, whose directory holds the id and
 * cwd its resume matches against.
 *
 * The slug is lowercased, every run of non-alphanumerics becomes one dash, and
 * the leading separator is dropped -- so there is no leading dash, which is
 * exactly where it differs from Claude Code's and Qwen's names. Derived from
 * observed output rather than source (the CLI ships minified), then checked
 * against three cwds chosen to pin the parts that could differ:
 *
 *   /home/user/projects/app         -> home-user-projects-app
 *   /tmp/probe/work.dir_x/A b              -> tmp-probe-work-dir-x-a-b
 *   /tmp/probe/x__y/z--w                   -> tmp-probe-x-y-z-w
 *
 * The second pins case folding and the dot/underscore/space cases; the third
 * pins that runs collapse to a single dash rather than one dash each.
 *
 * Command Code redirects the whole HOME per account rather than taking a
 * dedicated profile variable, so `HOME` here is the profile.
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
  sequentialIds, testedVersion, writeFileAtomic,
} from './thread-writer-files.js';

export function commandProjectSlug(workspace: string): string {
  return workspace.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function commandRoot(environment: NativeSessionEnvironment): string {
  return join(nativeDataRoot(environment, 'HOME', homedir()), '.commandcode', 'projects');
}

/** Command Code's own tool for a call (its bundled reference/tools.md):
 *  shell_command, read_file, write_file, edit_file, grep, glob, web_fetch,
 *  web_search. File tools take absolute paths. Anything else is told as
 *  text. */
function commandCall(workspace: string) {
  return (call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined => {
    const path = callPath(call);
    const file = path ? absolutePath(workspace, path) : undefined;
    const name = call.name.toLowerCase();
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command)$/.test(name))) {
      const command = callCommand(call);
      return command ? { name: 'shell_command', args: { command } } : undefined;
    }
    if (call.category === 'read' && file) return { name: 'read_file', args: { file_path: file } };
    if (call.category === 'edit' && file) {
      if (isWriteCall(call)) return { name: 'write_file', args: { file_path: file, content: inputString(call, 'content', 'file_text', 'text') ?? '' } };
      const oldString = inputString(call, 'old_string', 'oldText', 'old_str');
      const newString = inputString(call, 'new_string', 'newText', 'new_str');
      return oldString !== undefined && newString !== undefined
        ? { name: 'edit_file', args: { file_path: file, old_string: oldString, new_string: newString } } : undefined;
    }
    if (call.category === 'search') {
      const pattern = inputString(call, 'pattern', 'query', 'regex') ?? call.target;
      if (!pattern) return undefined;
      const where = inputString(call, 'path', 'dir_path', 'directory');
      const args = { pattern, ...(where ? { path: absolutePath(workspace, where) } : {}) };
      return { name: /glob|find|list|ls/.test(name) ? 'glob' : 'grep', args };
    }
    if (call.category === 'fetch') {
      const url = inputString(call, 'url', 'uri');
      if (url) return { name: 'web_fetch', args: { url } };
      const query = inputString(call, 'query', 'q') ?? call.target;
      return query ? { name: 'web_search', args: { query } } : undefined;
    }
    return undefined;
  };
}

export interface CommandThreadOptions {
  sessionId: string;
  workspace: string;
  model: string | null;
  now: Date;
  entryId?: () => string;
  messageId?: () => string;
}

/** The thread as Command Code 1.74 writes it: a version-3 session header,
 *  then parent-linked `message` entries whose content is Anthropic-shaped
 *  (`tool_use` in the assistant message, `tool_result` in the next user
 *  message), each with the `meta.source` Command Code stamps (user, model,
 *  tool). Observed from a real headless turn; the `.checkpoints.jsonl` and
 *  `.meta.json` sidecars are not part of resuming (see above) and are not
 *  written. */
export function commandThreadLines(record: CanonicalRecord, options: CommandThreadOptions): string {
  const entryId = options.entryId ?? (() => randomUUID().replace(/-/g, '').slice(0, 8));
  const messageId = options.messageId ?? randomUUID;
  const callId = sequentialIds('toolu_clikcode_');
  const start = options.now.getTime();
  let tick = 0;
  const lines: unknown[] = [{ type: 'session', version: 3, id: options.sessionId, timestamp: new Date(start).toISOString(), cwd: options.workspace }];
  let parentId: string | null = null;
  const append = (message: Record<string, unknown>, source: 'user' | 'model' | 'tool', model?: string): void => {
    const ms = start + tick;
    tick += 1;
    const id = entryId();
    const meta = { source, ...(source === 'tool' ? {} : { createdAt: ms }), messageId: messageId() };
    lines.push({
      type: 'message', id, parentId, timestamp: new Date(ms).toISOString(), message: { ...message, meta },
      ...(source === 'model' ? { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, model } : {}),
    });
    parentId = id;
  };
  const map = commandCall(options.workspace);
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !parentId) append({ role: 'user', content: [{ type: 'text', text: request.trim() ? request : '(continue)' }] }, 'user');
    const model = turn.origin.model ?? options.model ?? 'unknown';
    for (const step of assistantSteps(turn, map, callId)) {
      append({
        role: 'assistant',
        content: [
          ...(step.text ? [{ type: 'text', text: step.text }] : []),
          ...step.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })),
        ],
      }, 'model', model);
      if (step.calls.length) {
        append({
          role: 'user',
          content: step.calls.map((call) => ({ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: callResultText(call.call) }] })),
        }, 'tool');
      }
    }
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** Verified against Command Code 1.74.1 (2026-10-04, vendor-sandbox): the
 *  golden conversation written here, resumed the way ClikCode resumes it
 *  (`cmdc --print --output-format json --resume <id>`, BYOK OpenRouter
 *  gemini-2.5-flash-lite), answered "You asked me to remember PELICAN-73,
 *  and I read notes.txt and edited src/app.ts." -- every written message,
 *  the Codex shell call as `shell_command` and the Claude Grep as `grep`,
 *  went to the model, and the turn was appended to the same file. */
export const commandThreadWriter: NativeThreadWriter = {
  testedVersions: ['1.74.1'],
  versionOk: testedVersion(['1.74.1']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const sessionId = randomUUID();
    const path = join(commandRoot(context.environment), commandProjectSlug(context.workspace), `${sessionId}.jsonl`);
    await writeFileAtomic(path, commandThreadLines(record, { sessionId, workspace: context.workspace, model: context.model, now: new Date() }));
    return { nativeId: sessionId };
  },
};

export const commandSessionStore: NativeSessionStore = {
  root: commandRoot,
  async locate(root: string, nativeId: string, workspace: string): Promise<NativeSessionFile | undefined> {
    const path = join(root, commandProjectSlug(workspace), `${nativeId}.jsonl`);
    return await stat(path).then(() => ({ path, root }), () => undefined);
  },
  writer: commandThreadWriter,
};

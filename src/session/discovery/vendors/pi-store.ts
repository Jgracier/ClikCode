/** Pi: `<PI_CODING_AGENT_DIR>/sessions/**\/<id>.jsonl`, or `~/.pi/agent/sessions`
 *  when the profile variable is unset.
 *
 *  The filename IS the session id, nested under a project directory whose
 *  escaping scheme discoverPiFsSessions deliberately does not assume -- it
 *  walks instead, and so does this, for the same reason. */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { walkFilesRecursive } from '../files.js';
import {
  type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore, type NativeThreadWriter,
} from '../stores.js';
import {
  assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText, sequentialIds,
  testedVersion, writeFileAtomic,
} from './thread-writer-files.js';

function piRoot(environment: NativeSessionEnvironment): string {
  const configured = environment.PI_CODING_AGENT_DIR?.trim();
  return configured ? join(configured, 'sessions') : join(homedir(), '.pi', 'agent', 'sessions');
}

/** Pi's own project directory name (core/session-manager.js
 *  getDefaultSessionDirPath): the leading separator dropped, every `/`, `\`
 *  and `:` a dash, wrapped in `--`. Observed: /var/tmp/wfprobe/ws ->
 *  `--var-tmp-wfprobe-ws--`. */
export function piProjectDirectoryName(workspace: string): string {
  return `--${workspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** Pi's built-in tools (read, bash, edit, write) for a call that has one;
 *  anything else -- a search, a fetch, an MCP call -- is told as text, since
 *  grep/find/ls are off by default and a call to a tool the session does not
 *  have reads as one the model never made. */
function piCall(call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined {
  const path = callPath(call);
  if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command)$/i.test(call.name))) {
    const command = callCommand(call);
    return command ? { name: 'bash', args: { command } } : undefined;
  }
  if (call.category === 'read' && path) return { name: 'read', args: { path } };
  if (call.category === 'edit' && path) {
    if (isWriteCall(call)) {
      const content = inputString(call, 'content', 'file_text', 'text');
      return { name: 'write', args: { path, content: content ?? '' } };
    }
    const oldText = inputString(call, 'old_string', 'oldText', 'old_str');
    const newText = inputString(call, 'new_string', 'newText', 'new_str');
    return { name: 'edit', args: { path, edits: oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [] } };
  }
  return undefined;
}

export interface PiThreadOptions {
  sessionId: string;
  workspace: string;
  model: string | null;
  now: Date;
  /** Entry ids; Pi's own are eight hex characters. */
  entryId?: () => string;
}

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The thread as Pi 0.87 writes it (session format version 3): a header,
 *  then one `message` entry per user message, assistant response and tool
 *  result, each parented on the one before. No system message: Pi declares
 *  its prompt and tools on the next request, which its format allows. */
export function piThreadLines(record: CanonicalRecord, options: PiThreadOptions): string {
  const entryId = options.entryId ?? (() => randomUUID().replace(/-/g, '').slice(0, 8));
  const callId = sequentialIds('call_clikcode_');
  const start = options.now.getTime();
  let tick = 0;
  const stamp = (): { iso: string; ms: number } => {
    const ms = start + tick;
    tick += 1;
    return { iso: new Date(ms).toISOString(), ms };
  };
  const lines: unknown[] = [{ type: 'session', version: 3, id: options.sessionId, timestamp: new Date(start).toISOString(), cwd: options.workspace }];
  let parentId: string | null = null;
  const append = (message: Record<string, unknown>): void => {
    const { iso, ms } = stamp();
    const id = entryId();
    lines.push({ type: 'message', id, parentId, timestamp: iso, message: { ...message, timestamp: ms } });
    parentId = id;
  };
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !parentId) append({ role: 'user', content: [{ type: 'text', text: request.trim() ? request : '(continue)' }] });
    const model = turn.origin.model ?? options.model ?? 'unknown';
    const provider = turn.origin.provider ?? turn.origin.harness ?? 'clikcode';
    for (const step of assistantSteps(turn, piCall, callId)) {
      append({
        role: 'assistant',
        content: [
          ...(step.text ? [{ type: 'text', text: step.text }] : []),
          ...step.calls.map((call) => ({ type: 'toolCall', id: call.id, name: call.name, arguments: call.args })),
        ],
        api: 'openai-completions', provider, model, usage: ZERO_USAGE,
        stopReason: step.calls.length ? 'toolUse' : 'stop',
      });
      for (const call of step.calls) {
        append({
          role: 'toolResult', toolCallId: call.id, toolName: call.name,
          content: [{ type: 'text', text: callResultText(call.call) }],
          isError: call.call.status !== 'done',
        });
      }
    }
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** Verified against Pi 0.87.0 (2026-10-04, vendor-sandbox): the golden
 *  conversation written here, resumed the way ClikCode resumes Pi
 *  (`pi -p --mode json --session <id>`, OpenRouter gemini-2.5-flash-lite),
 *  answered "The codeword was PELICAN-73, and I read notes.txt and changed
 *  src/app.ts." -- Pi replayed every written message, the Codex shell call
 *  as its own `bash` call, and appended the new turn to the same file. */
export const piThreadWriter: NativeThreadWriter = {
  testedVersions: ['0.87.0'],
  versionOk: testedVersion(['0.87.0']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const sessionId = randomUUID();
    const now = new Date();
    const path = join(
      piRoot(context.environment), piProjectDirectoryName(context.workspace),
      `${now.toISOString().replace(/[:.]/g, '-')}_${sessionId}.jsonl`,
    );
    await writeFileAtomic(path, piThreadLines(record, { sessionId, workspace: context.workspace, model: context.model, now }));
    return { nativeId: sessionId };
  },
};

export const piSessionStore: NativeSessionStore = {
  root: piRoot,
  async locate(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
    // Pi 0.87 names a file `<timestamp>_<id>.jsonl`; a bare `<id>.jsonl`
    // is accepted too.
    const wanted = `${nativeId}.jsonl`;
    for (const path of await walkFilesRecursive(root, 3, '.jsonl').catch(() => [])) {
      if (path.endsWith(`/${wanted}`) || path.endsWith(`_${wanted}`)) return { path, root };
    }
    return undefined;
  },
  writer: piThreadWriter,
};

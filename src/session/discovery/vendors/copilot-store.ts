/** GitHub Copilot CLI keeps one DIRECTORY per conversation.
 *
 * `<COPILOT_HOME>/session-state/<session_id>/`, where the id is exactly the
 * one its stream reports and ClikCode already stores as nativeSessionId.
 * Directly observed: a turn driven through ClikCode minted
 * `93413ae0-a9eb-4924-b544-e2c98cdaf8dd` and wrote that directory, holding
 *
 *   events.jsonl          the transcript, append-only, one JSON event a line
 *   workspace.yaml        id, cwd, git_root, repository, branch, title
 *   vscode.metadata.json  created/modified stamps
 *   checkpoints/index.md  checkpoint table, empty until one is taken
 *   .workspace-fork.lock  left behind after the session ends, so it is
 *                         ordinary state rather than a liveness lock
 *
 * The transcript alone is not enough to resume: workspace.yaml carries the id
 * and cwd the CLI matches against. That makes this the one vendor so far whose
 * conversation is a tree rather than a file, which is why carry.ts copies an
 * artifact rather than a file.
 *
 * Not every Copilot account is redirected -- an account with no profile runs
 * against the default `~/.copilot` -- so the fallback here is load-bearing
 * rather than defensive: it is the real root for that account.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
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

function copilotRoot(environment: NativeSessionEnvironment): string {
  return join(nativeDataRoot(environment, 'COPILOT_HOME', join(homedir(), '.copilot')), 'session-state');
}

/** Copilot CLI's own tool for a call (its 1.0.91 declarations): bash, view,
 *  create, edit, grep, glob. Paths are absolute. A fetch is told as text:
 *  web_fetch is not declared in every mode (offline/BYOK has none). */
function copilotCall(workspace: string) {
  return (call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined => {
    const path = callPath(call);
    const file = path ? absolutePath(workspace, path) : undefined;
    const name = call.name.toLowerCase();
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command)$/.test(name))) {
      const command = callCommand(call);
      return command ? { name: 'bash', args: { command, description: call.label } } : undefined;
    }
    if (call.category === 'read' && file) return { name: 'view', args: { path: file } };
    if (call.category === 'edit' && file) {
      if (isWriteCall(call)) return { name: 'create', args: { path: file, file_text: inputString(call, 'content', 'file_text', 'text') ?? '' } };
      const oldString = inputString(call, 'old_string', 'oldText', 'old_str');
      const newString = inputString(call, 'new_string', 'newText', 'new_str');
      return oldString !== undefined && newString !== undefined
        ? { name: 'edit', args: { path: file, old_str: oldString, new_str: newString } } : undefined;
    }
    if (call.category === 'search') {
      const pattern = inputString(call, 'pattern', 'query', 'regex') ?? call.target;
      if (!pattern) return undefined;
      const where = inputString(call, 'path', 'dir_path', 'directory');
      const args = { pattern, ...(where ? { paths: [absolutePath(workspace, where)] } : {}) };
      return { name: /glob|find|list|ls/.test(name) ? 'glob' : 'grep', args };
    }
    return undefined;
  };
}

export interface CopilotThreadOptions {
  sessionId: string;
  workspace: string;
  model: string | null;
  /** The Copilot build recorded on session.start (`1.0.91`). */
  version: string;
  now: Date;
  uuid?: () => string;
}

/** A YAML scalar: JSON's double-quoted string is valid YAML. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** The session as Copilot CLI 1.0.91 writes one: `events.jsonl`, each event
 *  `{type, data, id, timestamp, parentId}` chained on the one before --
 *  session.start, then per request a user.message and, per model response,
 *  assistant.turn_start / assistant.message (text + toolRequests) /
 *  tool.execution_start + tool.execution_complete per call /
 *  assistant.turn_end -- and `workspace.yaml` naming the id and cwd its
 *  resume matches against. No system.message (Copilot sends its own prompt
 *  on the next request) and no reasoning: it is encrypted, and optional. */
export function copilotThreadFiles(record: CanonicalRecord, options: CopilotThreadOptions): { events: string; workspace: string } {
  const uuid = options.uuid ?? randomUUID;
  const callId = sequentialIds('call_clikcode_');
  const start = options.now.getTime();
  let tick = 0;
  const events: unknown[] = [];
  let parentId: string | null = null;
  const emit = (type: string, data: Record<string, unknown>): void => {
    const id = uuid();
    events.push({ type, data, id, timestamp: new Date(start + (tick++)).toISOString(), parentId });
    parentId = id;
  };
  emit('session.start', {
    sessionId: options.sessionId, version: 1, producer: 'copilot-agent', copilotVersion: options.version,
    startTime: options.now.toISOString(), selectedModel: options.model ?? undefined, contextTier: null,
    context: { cwd: options.workspace }, alreadyInUse: false, remoteSteerable: false,
  });
  const map = copilotCall(options.workspace);
  let firstRequest = '';
  for (const turn of record.turns) {
    const request = requestText(turn);
    const interactionId = uuid();
    let userMessageId: string | undefined;
    if (request.trim() || events.length === 1) {
      const content = request.trim() ? request : '(continue)';
      firstRequest ||= content;
      userMessageId = uuid();
      emit('user.message', { content, messageId: userMessageId, interactionId, turnId: '0' });
    }
    const model = turn.origin.model ?? options.model ?? 'unknown';
    assistantSteps(turn, map, callId).forEach((step, index) => {
      const turnId = String(index);
      emit('assistant.turn_start', { turnId, interactionId });
      emit('assistant.message', {
        messageId: uuid(), ...(userMessageId ? { originatingMessageId: userMessageId } : {}), model, content: step.text,
        toolRequests: step.calls.map((call) => ({ toolCallId: call.id, name: call.name, arguments: call.args, type: 'function' })),
        interactionId, turnId,
      });
      for (const call of step.calls) emit('tool.execution_start', { toolCallId: call.id, toolName: call.name, arguments: call.args, turnId, model });
      for (const call of step.calls) {
        emit('tool.execution_complete', {
          toolCallId: call.id, model, interactionId, turnId, success: call.call.status === 'done',
          result: { content: callResultText(call.call) },
        });
      }
      emit('assistant.turn_end', { turnId });
    });
  }
  const updated = new Date(start + Math.max(0, tick - 1)).toISOString();
  const workspace = [
    `id: ${options.sessionId}`,
    `cwd: ${yamlString(options.workspace)}`,
    'client_name: github/cli',
    `name: ${yamlString(firstRequest.replace(/\s+/g, ' ').trim().slice(0, 80))}`,
    'user_named: false',
    'summary_count: 0',
    'fork_count: 0',
    `created_at: ${options.now.toISOString()}`,
    `updated_at: ${updated}`,
    '',
  ].join('\n');
  return { events: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, workspace };
}

/** Verified against Copilot CLI 1.0.91 (2026-10-04, vendor-sandbox). Over
 *  ACP (ClikCode's Copilot transport), `session/load` replayed every written
 *  message and call, and the next prompt on the signed-in account
 *  (gpt-5-mini) answered "Codeword: PELICAN-73; earlier files read/changed:
 *  notes.txt, src/app.ts." The CLI's `--session-id <id>` sent the same
 *  history to the model (checked against a local BYOK endpoint), so the
 *  thread is not pinned to either transport. */
export const copilotThreadWriter: NativeThreadWriter = {
  testedVersions: ['1.0.91'],
  versionOk: testedVersion(['1.0.91']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const sessionId = randomUUID();
    const root = copilotRoot(context.environment);
    const files = copilotThreadFiles(record, {
      sessionId, workspace: context.workspace, model: context.model, version: versionNumber(context.version) ?? '', now: new Date(),
    });
    // The whole directory appears at once: built under a temporary name,
    // then renamed to the id.
    const staging = join(root, `.clikcode-${sessionId}.tmp`);
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await writeFileAtomic(join(staging, 'events.jsonl'), files.events);
      await writeFileAtomic(join(staging, 'workspace.yaml'), files.workspace);
      await rename(staging, join(root, sessionId));
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    return { nativeId: sessionId };
  },
};

export const copilotSessionStore: NativeSessionStore = {
  root: copilotRoot,
  async locate(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
    const path = join(root, nativeId);
    return await stat(path).then(
      (entry) => (entry.isDirectory() ? { path, root } : undefined),
      () => undefined,
    );
  },
  writer: copilotThreadWriter,
};

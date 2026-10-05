/** Augment Auggie: `~/.augment/sessions/<id>.json`, the whole conversation as
 *  Augment chat exchanges.
 *
 * Observed (vendor-sandbox, auggie 0.36.0, its tenant URL pointed at a local
 * stub of Augment's API that logged every request): auggie is the client of
 * a stateless backend -- each `chat-stream` request carries the session's
 * `chatHistory[].exchange`s as `chat_history`, so the file IS what the model
 * is told. An exchange is one request (a `text_node` or the `tool_result_node`s
 * answering the previous exchange) and one response (`response_text`, a raw
 * text node and `tool_use` nodes; auggie sends the nodes and blanks the
 * plain-text copies). A resume (`--resume <id>`, ACP `session/load`) reads
 * the file; there is no other index.
 *
 * Carry checked live against auggie 0.36.0 (2026-10-05, temp homes A and B
 * with the same Augment sign-in), short of the model's answer: a session
 * started over ACP in A ("Remember the word <W>. Reply OK."), carried by
 * carryNativeSession ('carried'), then `session/load` in B succeeded and
 * replayed the prompt with the word (an id never carried: "Session not
 * found"); A unchanged. The prompts were answered "You have run out of
 * usage for <account>", so the recall itself is unproved.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore, type NativeThreadWriter } from '../stores.js';
import {
  assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText, sequentialIds,
  testedVersion, writeFileAtomic,
} from './thread-writer-files.js';

function auggieRoot(environment: NativeSessionEnvironment): string {
  return join(environment.HOME?.trim() || homedir(), '.augment', 'sessions');
}

/** One session's file: the path the writer writes and locate looks for. */
function auggieSessionPath(root: string, sessionId: string): string {
  return join(root, `${sessionId}.json`);
}

/** Augment's own tools: launch-process, view, str-replace-editor, save-file,
 *  web-fetch. */
function auggieCall(workspace: string): (call: CanonicalToolCall) => { name: string; args: Record<string, unknown> } | undefined {
  return (call) => {
    const path = callPath(call);
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|execute|run_shell_command|shell_command)$/i.test(call.name))) {
      const command = callCommand(call);
      return command ? { name: 'launch-process', args: { command, wait: true, max_wait_seconds: 600, cwd: workspace } } : undefined;
    }
    if (call.category === 'read' && path) return { name: 'view', args: { type: 'file', path } };
    if (call.category === 'edit' && path) {
      if (isWriteCall(call)) return { name: 'save-file', args: { path, file_content: inputString(call, 'content', 'file_text', 'text') ?? '' } };
      const oldString = inputString(call, 'old_string', 'oldText', 'old_str');
      const newString = inputString(call, 'new_string', 'newText', 'new_str');
      return oldString !== undefined && newString !== undefined
        ? { name: 'str-replace-editor', args: { command: 'str_replace', path, str_replace_entries: [{ old_str: oldString, new_str: newString }] } }
        : undefined;
    }
    if (call.category === 'fetch') {
      const url = inputString(call, 'url') ?? call.target;
      return url && /^https?:\/\//.test(url) ? { name: 'web-fetch', args: { url } } : undefined;
    }
    return undefined;
  };
}

export interface AuggieThreadOptions {
  sessionId: string;
  workspace: string;
  now: Date;
  requestId?: () => string;
  rootTaskUuid?: string;
}

/** The session file as auggie 0.36 writes it. */
export function auggieSession(record: CanonicalRecord, options: AuggieThreadOptions): string {
  const requestId = options.requestId ?? randomUUID;
  const callId = sequentialIds('toolu_clikcode_');
  const start = options.now.getTime();
  let tick = 0;
  const history: unknown[] = [];
  const push = (exchange: Record<string, unknown>): void => {
    history.push({
      exchange: { request_id: requestId(), ...exchange },
      completed: true, sequenceId: history.length + 1, finishedAt: new Date(start + tick).toISOString(),
      changedFiles: [], changedFilesSkipped: [], changedFilesSkippedCount: 0, source: 'local',
    });
    tick += 1;
  };
  const map = auggieCall(options.workspace);
  for (const turn of record.turns) {
    const request = requestText(turn);
    const text = request.trim() ? request : '(continue)';
    let pending: { message: string; nodes: unknown[] } = { message: text, nodes: [{ id: 1, type: 0, text_node: { content: text } }] };
    const steps = assistantSteps(turn, map, callId);
    for (const step of steps) {
      push({
        request_message: pending.message, request_nodes: pending.nodes, response_text: step.text,
        response_nodes: [
          ...(step.text ? [{ id: 0, type: 0, content: step.text }] : []),
          ...step.calls.map((call, index) => ({
            id: index + 1, type: 5, content: '', tool_use: { tool_use_id: call.id, tool_name: call.name, input_json: JSON.stringify(call.args) },
          })),
        ],
      });
      pending = {
        message: '',
        nodes: step.calls.map((call, index) => ({
          id: index + 1, type: 1,
          tool_result_node: { tool_use_id: call.id, content: callResultText(call.call), is_error: call.call.status !== 'done' },
        })),
      };
    }
    // The request still unanswered: a turn with no answer, or results after
    // the last calls.
    if (!steps.length || pending.nodes.length) push({ request_message: pending.message, request_nodes: pending.nodes, response_text: '', response_nodes: [] });
  }
  const at = options.now.toISOString();
  return `${JSON.stringify({
    sessionId: options.sessionId, created: at, modified: at, chatHistory: history,
    agentState: { userGuidelines: '', workspaceGuidelines: '', modelId: '', userEmail: '' },
    rootTaskUuid: options.rootTaskUuid ?? randomUUID(), subAgentCreditsUsed: 0, subAgentCostUsd: 0,
  }, null, 2)}\n`;
}

export const auggieThreadWriter: NativeThreadWriter = {
  testedVersions: ['0.36.0'],
  versionOk: testedVersion(['0.36.0']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const sessionId = randomUUID();
    await writeFileAtomic(auggieSessionPath(auggieRoot(context.environment), sessionId),
      auggieSession(record, { sessionId, workspace: context.workspace, now: new Date() }));
    return { nativeId: sessionId };
  },
};

/** Flat, not per workspace: the id alone places the file, and with no index
 * beside it the copy is the whole thread. */
async function locateAuggieSession(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
  const path = auggieSessionPath(root, nativeId);
  return await stat(path).then((entry) => (entry.isFile() ? { path, root } : undefined), () => undefined);
}

export const auggieSessionStore: NativeSessionStore = {
  root: auggieRoot,
  locate: locateAuggieSession,
  writer: auggieThreadWriter,
};

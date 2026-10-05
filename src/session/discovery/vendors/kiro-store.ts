/** Kiro CLI over ACP: `<HOME>/.kiro/sessions/cli/<id>.json` + `<id>.jsonl`.
 *
 * Kiro keeps two stores. `kiro-cli acp` (the v2 agent engine, ClikCode's
 * transport for Kiro) writes the flat `sessions/cli/` pair; the one-shot
 * CLI ClikCode falls back to (`chat --agent-engine v3`) writes
 * `sessions/<sha256(cwd)[:16]>/sess_<id>/` with its own index -- which is
 * why Kiro threads are pinned to the transport that made them
 * (`acp.legacyCliSessions`). This writer writes the ACP pair and pins the
 * thread to ACP.
 *
 * Observed (vendor-sandbox, kiro-cli 2.23.1, a real `session/new` turn and
 * then hand-written files loaded with `session/load`, which replays what it
 * parsed and costs nothing):
 *
 *   - `<id>.jsonl` is the conversation: `Prompt`, `AssistantMessage`
 *     (`text` and `toolUse` content) and `ToolResults` records, each
 *     `{ version: "v1", kind, data }`.
 *   - `<id>.json` must parse as Kiro's session metadata: `session_state`
 *     is required, `session_created_reason` may not be null.
 *   - A tool result's `results` map is what the replay reports the call's
 *     outcome from; with no entry the call reads as "cancelled by the user".
 *     Its `kind` is Kiro's internal tool enum, observed only for the shell
 *     (`BuiltIn.ExecuteCmd`), so only shell calls are written as Kiro tool
 *     calls; every other call is told as text.
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionStore, type NativeThreadWriter } from '../stores.js';
import { assistantSteps, callCommand, callResultText, requestText, sequentialIds, testedVersion, writeFileAtomic } from './thread-writer-files.js';

function kiroRoot(environment: NativeSessionEnvironment): string {
  return join(nativeDataRoot(environment, 'HOME', homedir()), '.kiro', 'sessions', 'cli');
}

/** Kiro's `shell` for a run call; nothing else (see above). */
function kiroCall(call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined {
  if (call.category !== 'run' && !(!call.category && /^(bash|shell|exec|run_shell_command|shell_command|execute_bash)$/i.test(call.name))) return undefined;
  const command = callCommand(call);
  return command ? { name: 'shell', args: { command } } : undefined;
}

export interface KiroThreadOptions {
  sessionId: string;
  workspace: string;
  now: Date;
  messageId?: () => string;
  callId?: () => string;
}

/** `<id>.jsonl` and `<id>.json` as kiro-cli 2.23.1's ACP agent writes them. */
export function kiroThreadFiles(record: CanonicalRecord, options: KiroThreadOptions): { messages: string; session: string } {
  const messageId = options.messageId ?? randomUUID;
  const callId = options.callId ?? sequentialIds('tooluse_clikcode_');
  const seconds = Math.floor(options.now.getTime() / 1000);
  const lines: unknown[] = [];
  const add = (kind: string, data: Record<string, unknown>): void => {
    lines.push({ version: 'v1', kind, data: { message_id: messageId(), ...data } });
  };
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !lines.length) {
      add('Prompt', { content: [{ kind: 'text', data: request.trim() ? request : '(continue)' }], meta: { timestamp: seconds } });
    }
    for (const step of assistantSteps(turn, kiroCall, callId)) {
      add('AssistantMessage', {
        content: [
          ...(step.text ? [{ kind: 'text', data: step.text }] : []),
          ...step.calls.map((call) => ({ kind: 'toolUse', data: { toolUseId: call.id, name: call.name, input: call.args } })),
        ],
      });
      if (!step.calls.length) continue;
      const results: Record<string, unknown> = {};
      const content = step.calls.map((call) => {
        if (call.call.status === 'unfinished') {
          return { kind: 'toolResult', data: { toolUseId: call.id, content: [{ kind: 'text', data: callResultText(call.call) }], status: 'error' } };
        }
        const output = { exit_status: `exit status: ${call.call.exitCode ?? (call.call.status === 'failed' ? 1 : 0)}`, stdout: callResultText(call.call), stderr: '' };
        results[call.id] = {
          tool: { tool_use_purpose: null, kind: { BuiltIn: { ExecuteCmd: { command: call.args.command, working_dir: null } } } },
          result: { Success: { items: [{ Json: output }] } },
        };
        return { kind: 'toolResult', data: { toolUseId: call.id, content: [{ kind: 'json', data: output }], status: 'success' } };
      });
      add('ToolResults', { content, results });
    }
  }
  const at = options.now.toISOString();
  const title = record.turns.find((turn) => turn.user.trim())?.user.trim().replace(/\s+/g, ' ').slice(0, 120) ?? null;
  const session = {
    session_id: options.sessionId,
    cwd: options.workspace,
    created_at: at,
    updated_at: at,
    title,
    // What Kiro's ACP agent records for a session it creates; null fails to parse.
    session_created_reason: 'subagent',
    session_state: {
      version: 'v1',
      conversation_metadata: { user_turn_metadatas: [], last_context_usage: null, user_turn_start_request: null, last_request: null },
      rts_model_state: { conversation_id: options.sessionId, model_info: null, context_usage_percentage: null },
      permissions: {
        filesystem: { allowed_read_paths: [options.workspace], allowed_write_paths: [], denied_read_paths: [], denied_write_paths: [] },
        trusted_tools: [], denied_tools: [], allowed_commands: [],
      },
      agent_name: 'kiro_default',
      goal: null,
    },
  };
  return {
    messages: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    session: `${JSON.stringify(session, null, 2)}\n`,
  };
}

/** Verified against kiro-cli 2.23.1 (2026-10-04, vendor-sandbox, Kiro
 *  account, qwen3-coder-next): the golden conversation written here,
 *  resumed the way ClikCode resumes it -- ACP `session/load` +
 *  `session/prompt` -- answered "Codeword: EGRET-19 / notes.txt said:
 *  launch window: Thursday / Change in src/app.ts: `cosnt` -> `const`" (the
 *  Codex shell call as Kiro's shell, the Claude Edit as text). */
export const kiroThreadWriter: NativeThreadWriter = {
  testedVersions: ['2.23.1'],
  versionOk: testedVersion(['2.23.1']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const sessionId = randomUUID();
    const root = kiroRoot(context.environment);
    const files = kiroThreadFiles(record, { sessionId, workspace: context.workspace, now: new Date() });
    // The conversation first, the metadata that makes it a session last:
    // until `<id>.json` exists Kiro does not know the id.
    const conversation = join(root, `${sessionId}.jsonl`);
    await writeFileAtomic(conversation, files.messages);
    try {
      await writeFileAtomic(join(root, `${sessionId}.json`), files.session);
    } catch (error) {
      await rm(conversation, { force: true });
      throw error;
    }
    return { nativeId: sessionId, transport: 'acp' };
  },
};

export const kiroSessionStore: NativeSessionStore = {
  root: kiroRoot,
  writer: kiroThreadWriter,
};

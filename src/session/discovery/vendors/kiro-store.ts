/** Kiro CLI over ACP: `<HOME>/.kiro/sessions/cli/<id>.json` + `<id>.jsonl`.
 *
 * Kiro keeps two stores. `kiro-cli acp` (the v2 agent engine, ClikCode's
 * transport for Kiro) writes the flat `sessions/cli/` pair; the one-shot
 * CLI ClikCode falls back to (`chat --agent-engine v3`) writes
 * `sessions/<sha256(cwd)[:16]>/sess_<id>/` with its own index -- which is
 * why Kiro threads are pinned to the transport that made them
 * (session `nativeTransport`). This writer writes the ACP pair and pins the
 * thread to ACP.
 *
 * No `locate`: an ACP session is two sibling files in a directory shared
 * with every other session, not one path, so the single-path copy in
 * session/carry.ts cannot carry it. The store carries the pair itself
 * (`carry`), the conversation first, as the writer writes it.
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
 *     Its `kind` is Kiro's internal tool enum. Observed from a real turn that
 *     read, edited, created and searched with Kiro's own tools: `read` is
 *     `FileRead` (`operations: [{ mode: "Line", path }]`), `write` is
 *     `FileWrite` (`command: "strReplace"` with `oldStr`/`newStr`, or
 *     `"create"` with `content`), `grep` is `Grep`, `glob` is `Glob`, the
 *     shell is `ExecuteCmd`; a result item is `{ Text }` or `{ Json }`.
 *     Calls with none of those shapes (fetch, MCP, ...) are told as text.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { nativeDataRoot, type NativeSessionCarry, type NativeSessionEnvironment, type NativeSessionStore, type NativeThreadWriter } from '../stores.js';
import {
  absolutePath, assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText, sequentialIds, testedVersion,
  writeFileAtomic, type VendorCall,
} from './thread-writer-files.js';

function kiroRoot(environment: NativeSessionEnvironment): string {
  return join(nativeDataRoot(environment, 'HOME', homedir()), '.kiro', 'sessions', 'cli');
}

/** One ACP session's two files, in the order they are written and carried:
 *  the conversation, then the metadata that makes the id a session. */
function kiroSessionFiles(root: string, sessionId: string): { conversation: string; session: string } {
  return { conversation: join(root, `${sessionId}.jsonl`), session: join(root, `${sessionId}.json`) };
}

/** A call as one of Kiro's own tools (see above), paths absolute. */
function kiroCall(workspace: string) {
  return (call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined => {
    const name = call.name.toLowerCase();
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command|execute_bash)$/.test(name))) {
      const command = callCommand(call);
      return command ? { name: 'shell', args: { command } } : undefined;
    }
    const path = callPath(call);
    const file = path ? absolutePath(workspace, path) : undefined;
    if (call.category === 'read' && file) return { name: 'read', args: { operations: [{ mode: 'Line', path: file }] } };
    if (call.category === 'edit' && file) {
      if (isWriteCall(call)) return { name: 'write', args: { command: 'create', path: file, content: inputString(call, 'content', 'file_text', 'text') ?? '' } };
      const oldStr = inputString(call, 'old_string', 'oldText', 'old_str', 'oldStr');
      const newStr = inputString(call, 'new_string', 'newText', 'new_str', 'newStr');
      return oldStr !== undefined && newStr !== undefined ? { name: 'write', args: { command: 'strReplace', path: file, oldStr, newStr } } : undefined;
    }
    if (call.category === 'search') {
      const pattern = inputString(call, 'pattern', 'query', 'regex', 'glob') ?? call.target;
      if (!pattern) return undefined;
      const where = absolutePath(workspace, inputString(call, 'path', 'dir_path', 'directory') ?? '.');
      return /glob|find|list|ls/.test(name)
        ? { name: 'glob', args: { pattern, path: where } }
        : { name: 'grep', args: { pattern, path: where, output_mode: 'content' } };
    }
    return undefined;
  };
}

/** The `results` entry Kiro keeps for a finished call: its tool enum and
 *  what it returned, as Kiro's own tools record them. */
function kiroResult(call: VendorCall): { text: string; result: Record<string, unknown>; json?: Record<string, unknown> } {
  const args = call.args;
  const recorded = callResultText(call.call);
  const tool = (kind: string, fields: Record<string, unknown>) => ({ tool_use_purpose: null, kind: { BuiltIn: { [kind]: fields } } });
  const text = (value: string, kind: string, fields: Record<string, unknown>) => ({
    text: value, result: { tool: tool(kind, fields), result: { Success: { items: [{ Text: value }] } } },
  });
  switch (call.name) {
    case 'shell': {
      const output = { exit_status: `exit status: ${call.call.exitCode ?? (call.call.status === 'failed' ? 1 : 0)}`, stdout: recorded, stderr: '' };
      return { text: recorded, json: output, result: { tool: tool('ExecuteCmd', { command: args.command, working_dir: null }), result: { Success: { items: [{ Json: output }] } } } };
    }
    case 'read': {
      const operations = (args.operations as Record<string, unknown>[]).map((operation) => ({ ...operation, limit: null, offset: null }));
      return text(recorded, 'FileRead', { operations });
    }
    case 'write': {
      const done = args.command === 'create'
        ? `Successfully created ${args.path} (${String(args.content).split('\n').filter(Boolean).length} lines).`
        : `Successfully replaced 1 occurrence(s) in ${args.path}.`;
      return text(call.call.output?.length ? recorded : done, 'FileWrite', args.command === 'create' ? args : { ...args, replaceAll: false });
    }
    case 'grep':
      return text(recorded, 'Grep', {
        pattern: args.pattern, path: args.path, include: null, case_sensitive: null, output_mode: 'content',
        max_matches_per_file: null, max_files: null, max_total_lines: null, max_depth: null,
      });
    default:
      return text(recorded, 'Glob', { pattern: args.pattern, path: args.path, limit: null, max_depth: null });
  }
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
  const map = kiroCall(options.workspace);
  const add = (kind: string, data: Record<string, unknown>): void => {
    lines.push({ version: 'v1', kind, data: { message_id: messageId(), ...data } });
  };
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !lines.length) {
      add('Prompt', { content: [{ kind: 'text', data: request.trim() ? request : '(continue)' }], meta: { timestamp: seconds } });
    }
    for (const step of assistantSteps(turn, map, callId)) {
      add('AssistantMessage', {
        content: [
          ...(step.text ? [{ kind: 'text', data: step.text }] : []),
          ...step.calls.map((call) => ({ kind: 'toolUse', data: { toolUseId: call.id, name: call.name, input: call.args } })),
        ],
      });
      if (!step.calls.length) continue;
      const results: Record<string, unknown> = {};
      const content = step.calls.map((call) => {
        // A call that did not succeed has no `results` entry: Kiro replays
        // it as not completed, and the text says what happened.
        if (call.call.status === 'unfinished' || (call.call.status === 'failed' && call.name !== 'shell')) {
          return { kind: 'toolResult', data: { toolUseId: call.id, content: [{ kind: 'text', data: callResultText(call.call) }], status: 'error' } };
        }
        const done = kiroResult(call);
        results[call.id] = done.result;
        return { kind: 'toolResult', data: { toolUseId: call.id, content: [done.json ? { kind: 'json', data: done.json } : { kind: 'text', data: done.text }], status: 'success' } };
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
 *  account, qwen3-coder-next), resumed the way ClikCode resumes it -- ACP
 *  `session/load` + `session/prompt`. A conversation with a Codex shell call
 *  and Claude Read, Edit, Grep and Write calls replayed as Kiro's own
 *  shell, read, write, grep and write, all completed, and the model answered
 *  "Codeword: PELICAN-73; notes.txt: launch window Thursday; config.ini:
 *  port 8417; src/app.ts: fixed `cosnt` -> `const`; created: TODO.md." */
export const kiroThreadWriter: NativeThreadWriter = {
  testedVersions: ['2.23.1'],
  versionOk: testedVersion(['2.23.1']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const sessionId = randomUUID();
    const { conversation, session } = kiroSessionFiles(kiroRoot(context.environment), sessionId);
    const files = kiroThreadFiles(record, { sessionId, workspace: context.workspace, now: new Date() });
    // The conversation first, the metadata that makes it a session last:
    // until `<id>.json` exists Kiro does not know the id.
    await writeFileAtomic(conversation, files.messages);
    try {
      await writeFileAtomic(session, files.session);
    } catch (error) {
      await rm(conversation, { force: true });
      throw error;
    }
    return { nativeId: sessionId, transport: 'acp' };
  },
};

/** Size and recency of a session's pair taken together, the way carry.ts
 *  measures a directory; undefined unless both files are there. */
async function measureKiroSession(files: { conversation: string; session: string }): Promise<{ size: number; mtime: number } | undefined> {
  const entries = await Promise.all([files.conversation, files.session].map((path) => stat(path).catch(() => undefined)));
  if (entries.some((entry) => !entry?.isFile())) return undefined;
  return {
    size: entries.reduce((sum, entry) => sum + entry!.size, 0),
    mtime: Math.max(...entries.map((entry) => entry!.mtimeMs)),
  };
}

/** Copies one session's pair into `to`, touching no other session. Both are
 * staged under temporary names first, so a failed copy changes nothing; then
 * renamed into place conversation first, as the writer writes them. A copy
 * already there that is as long and as recent stays (carry.ts's rule: the
 * transcript is append-only, so the newer, longer one is current). */
async function carryKiroSession(input: NativeSessionCarry): Promise<boolean> {
  const source = kiroSessionFiles(kiroRoot(input.from), input.nativeId);
  const target = kiroSessionFiles(kiroRoot(input.to), input.nativeId);
  const [there, here] = await Promise.all([measureKiroSession(source), measureKiroSession(target)]);
  if (!there) return false;
  if (here && here.size >= there.size && here.mtime >= there.mtime) return true;
  await mkdir(kiroRoot(input.to), { recursive: true, mode: 0o700 });
  const order = ['conversation', 'session'] as const;
  const staged = { conversation: `${target.conversation}.clikcode-carry`, session: `${target.session}.clikcode-carry` };
  try {
    for (const file of order) await copyFile(source[file], staged[file]);
    for (const file of order) await rename(staged[file], target[file]);
  } finally {
    await Promise.all(order.map((file) => rm(staged[file], { force: true })));
  }
  return true;
}

export const kiroSessionStore: NativeSessionStore = {
  root: kiroRoot,
  carry: carryKiroSession,
  writer: kiroThreadWriter,
};

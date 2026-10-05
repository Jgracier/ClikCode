/** Devin CLI: every session in `<XDG_DATA_HOME or ~/.local/share>/devin/cli/
 *  sessions.db` -- a `sessions` row and a forest of `message_nodes`, the row's
 *  `main_chain_id` naming the head of the conversation.
 *
 * Observed (vendor-sandbox, devin 3000.11.3, signed in, swe-1-6-slow): Devin
 * keeps its system prompt as `is_system_prefix` nodes and REBUILDS that prefix
 * whenever it runs a session, copying the conversation's own nodes after it
 * (`compact/prior_node_ids`). So a written chain is just the conversation --
 * user, assistant (+ `tool_calls`), tool -- parented one on the next, and a
 * resume (`-r <id>`, ACP `session/load`) puts Devin's own current system
 * prompt in front of it. Only its shell tool (`exec {command}`) was observed;
 * other calls are told as text.
 *
 * The database and its schema are Devin's (refinery migrations): where Devin
 * never ran there is none, and the writer does not make one.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { type NativeSessionEnvironment, type NativeSessionStore, type NativeThreadWriter } from '../stores.js';
import { assistantSteps, callCommand, callResultText, requestText, sequentialIds, testedVersion } from './thread-writer-files.js';
import { carrySqliteSession, progressQuery, type SqliteCarrySpec } from './sqlite-carry.js';

function devinRoot(environment: NativeSessionEnvironment): string {
  const data = environment.XDG_DATA_HOME?.trim() || join(environment.HOME?.trim() || homedir(), '.local', 'share');
  return join(data, 'devin', 'cli');
}

function devinCall(call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined {
  if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command)$/i.test(call.name))) {
    const command = callCommand(call);
    return command ? { name: 'exec', args: { command } } : undefined;
  }
  return undefined;
}

export interface DevinThreadOptions {
  now: Date;
  messageId?: () => string;
}

/** The conversation as Devin's chat messages, in chain order. */
export function devinMessages(record: CanonicalRecord, options: DevinThreadOptions): Record<string, unknown>[] {
  const messageId = options.messageId ?? randomUUID;
  const callId = sequentialIds('call_clikcode_');
  const createdAt = options.now.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
  const metadata = (user: boolean): Record<string, unknown> => ({
    num_tokens: null, is_user_input: user ? true : null, request_id: null, metrics: null, finish_reason: null,
    created_at: createdAt, telemetry: { source: user ? 'user' : 'system', operation: 'unknown' },
  });
  const messages: Record<string, unknown>[] = [];
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !messages.length) {
      messages.push({ message_id: messageId(), role: 'user', content: request.trim() ? request : '(continue)', metadata: metadata(true) });
    }
    for (const step of assistantSteps(turn, devinCall, callId)) {
      messages.push({
        message_id: messageId(), role: 'assistant', content: step.text,
        tool_calls: step.calls.map((call, index) => ({ id: call.id, name: call.name, arguments: call.args, index, kind: 'function' })),
        metadata: metadata(false),
      });
      for (const call of step.calls) {
        messages.push({ message_id: messageId(), role: 'tool', content: callResultText(call.call), tool_call_id: call.id, metadata: metadata(false) });
      }
    }
  }
  return messages;
}

type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] };
  close(): void;
};

const SESSION_COLUMNS = [
  'id', 'working_directory', 'backend_type', 'model', 'agent_mode', 'created_at', 'last_activity_at', 'title',
  'main_chain_id', 'shell_last_seen_index', 'workspace_dirs', 'hidden',
];
const NODE_COLUMNS = ['session_id', 'node_id', 'parent_node_id', 'chat_message', 'created_at'];

/** Verified against devin 3000.11.3 (2026-10-04): see the module comment;
 *  live proof in the commit that added this. */
export const devinThreadWriter: NativeThreadWriter = {
  testedVersions: ['3000.11.3'],
  versionOk: testedVersion(['3000.11.3']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const database = join(devinRoot(context.environment), 'sessions.db');
    if (!(await stat(database).then((s) => s.isFile(), () => false))) return undefined;
    const now = new Date();
    const messages = devinMessages(record, { now });
    if (!messages.length) return undefined;
    // Devin's own ids are word pairs (`right-coffee`); any unique text resumes.
    const sessionId = `clikcode-${randomBytes(6).toString('hex')}`;
    const seconds = Math.floor(now.getTime() / 1000);
    const title = record.turns.find((turn) => turn.user.trim())?.user.trim().replace(/\s+/g, ' ').slice(0, 80) ?? 'ClikCode conversation';
    let db: Db | undefined;
    try {
      const sqlite = await import('node:sqlite') as { DatabaseSync: new (path: string) => Db };
      db = new sqlite.DatabaseSync(database);
      db.exec('PRAGMA busy_timeout = 3000');
      const have = (table: string): Set<string> => new Set((db!.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      const sessions = have('sessions');
      const nodes = have('message_nodes');
      if (!SESSION_COLUMNS.every((name) => sessions.has(name)) || !NODE_COLUMNS.every((name) => nodes.has(name))) return undefined;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO sessions (${SESSION_COLUMNS.join(',')}) VALUES (${SESSION_COLUMNS.map(() => '?').join(',')})`).run(
          sessionId, context.workspace, 'windsurf', context.model?.trim() ?? '', '', seconds, seconds, title,
          messages.length - 1, 0, '[]', 0,
        );
        const insert = db.prepare(`INSERT INTO message_nodes (${NODE_COLUMNS.join(',')}) VALUES (?, ?, ?, ?, ?)`);
        messages.forEach((message, index) => insert.run(sessionId, index, index ? index - 1 : null, JSON.stringify(message), seconds));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { nativeId: sessionId };
    } finally {
      try { db?.close(); } catch { /* fail-open-ok: the transaction already decided. */ }
    }
  },
};

/** One conversation in Devin 3000.11.3's sessions.db (schema read from one it
 *  made in vendor-sandbox): the `sessions` row, its `message_nodes` (node ids
 *  are per session, `main_chain_id` names one, so they carry as they are),
 *  and the other tables Devin keys on the session -- `tool_call_state`,
 *  `subagent_heads`, `rendered_commits` and its `prompt_history`. Row ids are
 *  AUTOINCREMENT and left to the destination.
 *
 *  Progress is the node chain in node order: Devin adds nodes as a session
 *  runs (its rebuilt system prefix included) rather than rewriting them.
 *
 *  Verified against devin 3000.11.3 (2026-10-05, vendor-sandbox, swe-1-6-slow,
 *  ACP as ClikCode drives it): a session made in profile A ("Remember the word
 *  MAPLE2A") was carried into a profile B already holding its own session
 *  ('carried'; A's chain and B's own session unchanged), and ClikCode's ACP resume of
 *  that id in B answered MAPLE2A. After a second turn in B ("remember the
 *  number 110") it was carried back, and A's resume answered "MAPLE2A 110". */
export const devinCarry: SqliteCarrySpec = {
  database: (environment) => join(devinRoot(environment), 'sessions.db'),
  session: { table: 'sessions', key: 'id', identity: ['created_at'] },
  rows: [
    { table: 'message_nodes', key: 'session_id', omit: ['row_id'], order: 'node_id' },
    { table: 'tool_call_state', key: 'session_id' },
    { table: 'subagent_heads', key: 'session_id' },
    { table: 'rendered_commits', key: 'session_id', omit: ['id'], order: 'sequence_number' },
    { table: 'prompt_history', key: 'session_id', omit: ['id'], order: 'id' },
  ],
  required: { sessions: SESSION_COLUMNS, message_nodes: NODE_COLUMNS },
  progress: progressQuery(
    'SELECT node_id || char(31) || chat_message AS k FROM {db}.message_nodes WHERE session_id = ? ORDER BY node_id',
  ),
};

export const devinSessionStore: NativeSessionStore = {
  root: devinRoot,
  carry: (input) => carrySqliteSession(devinCarry, input),
  writer: devinThreadWriter,
};

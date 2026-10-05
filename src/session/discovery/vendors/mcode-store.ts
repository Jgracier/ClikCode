/** MiniMax Code (`mcode`): `<data dir>/v2/sessions/<YYYY>/<MM>/<DD>/
 *  <HH-MM-SS-mmm>-session_<base64(id)>/messages.jsonl`, found through a row
 *  in `<data dir>/v2/sqlite/runtime-state.sqlite`. The data dir is
 *  MINIMAX_DATA_DIR (or MAVIS_DATA_DIR), else `~/.minimax`.
 *
 * Observed (vendor-sandbox, mcode 0.5.10, a custom OpenAI-compatible provider
 * pointed at a local stub that logged every request):
 *
 *   - mcode runs on the Pi agent. `messages.jsonl` is the model's history:
 *     one `{ message_id, turn_id, message }` line per Pi message -- `user`,
 *     `assistant` (`text` and `toolCall` content) and `toolResult`. A resume
 *     (`mcode exec --session <id>`, ACP `session/resume`) sends exactly these
 *     to the model, in order, and appends to the same file. The
 *     `history-catalog.json` revision and the byte-offset
 *     `user-message-locators.jsonl` beside it are NOT checked on resume (a
 *     hand-edited file was sent as edited), and a thread with only
 *     `messages.jsonl` resumed: mcode writes the rest itself.
 *   - The file alone is "Session not found": the session is a
 *     `local_runtime_sessions` row whose `history_relative_dir` names the
 *     directory (insert triggers file it under its project). Without a
 *     `local_runtime_pi_history_file_migrations` checkpoint mcode first tries
 *     to migrate history INTO the file, finds it non-empty, and fails the turn
 *     with "Conversation history could not be safely updated".
 *   - mcode prefixes its own reminders to each user message it stores; a
 *     resume replays a stored message as it is, so written requests carry
 *     none.
 *
 * The database is mcode's and its schema migrates by itself: a profile where
 * mcode has never run has none, and a writer must not invent one -- that
 * case, and any schema without the columns used here, is a transfer.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { type NativeSessionEnvironment, type NativeSessionStore, type NativeThreadWriter } from '../stores.js';
import {
  assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText, sequentialIds,
  testedVersion,
} from './thread-writer-files.js';
import { writeDirectoryAtomic } from './thread-writer-directory.js';
import { carrySqliteSession, type CarryDb, type CarrySchema, type SqliteCarrySpec } from './sqlite-carry.js';

/** mcode's data dir for an environment (its own `MINIMAX_DATA_DIR ||
 *  MAVIS_DATA_DIR || ~/.minimax`). */
function mcodeDataDir(environment: NativeSessionEnvironment): string {
  return environment.MINIMAX_DATA_DIR?.trim() || environment.MAVIS_DATA_DIR?.trim()
    || join(environment.HOME?.trim() || homedir(), '.minimax');
}

function mcodeRoot(environment: NativeSessionEnvironment): string {
  return join(mcodeDataDir(environment), 'v2', 'sessions');
}

/** mcode's own tools (its 0.5 tool declarations): bash, read, write, edit,
 *  grep, glob, web_fetch. A call it has none for is told as text. */
function mcodeCall(call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined {
  const name = call.name.toLowerCase();
  const path = callPath(call);
  if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command)$/.test(name))) {
    const command = callCommand(call);
    return command ? { name: 'bash', args: { command } } : undefined;
  }
  if (call.category === 'read' && path) return { name: 'read', args: { path } };
  if (call.category === 'edit' && path) {
    if (isWriteCall(call)) return { name: 'write', args: { path, content: inputString(call, 'content', 'file_text', 'text') ?? '' } };
    const oldString = inputString(call, 'old_string', 'oldText', 'old_str');
    const newString = inputString(call, 'new_string', 'newText', 'new_str');
    return oldString !== undefined && newString !== undefined
      ? { name: 'edit', args: { file_path: path, old_string: oldString, new_string: newString } } : undefined;
  }
  if (call.category === 'search') {
    const pattern = inputString(call, 'pattern', 'query', 'regex') ?? call.target;
    if (!pattern) return undefined;
    const where = inputString(call, 'path', 'dir_path', 'directory');
    return { name: /glob|find|list|ls/.test(name) ? 'glob' : 'grep', args: { pattern, ...(where ? { path: where } : {}) } };
  }
  if (call.category === 'fetch') {
    const url = inputString(call, 'url') ?? call.target;
    return url && /^https?:\/\//.test(url) ? { name: 'web_fetch', args: { url } } : undefined;
  }
  return undefined;
}

export interface McodeThreadOptions {
  sessionId: string;
  now: Date;
  messageId?: () => string;
  turnId?: () => string;
}

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const randomId = (): string => randomBytes(32).toString('base64url').slice(0, 43);

/** The conversation as mcode 0.5 stores it in `messages.jsonl`. */
export function mcodeThreadLines(record: CanonicalRecord, options: McodeThreadOptions): string {
  const messageId = options.messageId ?? randomId;
  const turnId = options.turnId ?? (() => `turn_clikcode_${randomBytes(6).toString('hex')}`);
  const callId = sequentialIds('call_clikcode_');
  const start = options.now.getTime();
  let tick = 0;
  const lines: unknown[] = [];
  for (const turn of record.turns) {
    const turnKey = turnId();
    const append = (prefix: string, message: Record<string, unknown>): void => {
      lines.push({ message_id: `${prefix}${messageId()}`, turn_id: turnKey, message: { ...message, timestamp: start + tick } });
      tick += 1;
    };
    const request = requestText(turn);
    if (request.trim() || !lines.length) {
      const text = request.trim() ? request : '(continue)';
      append('msg-user-v1-', {
        role: 'user', content: [{ type: 'text', text }], canonicalTextRange: { startOffset: 0, endOffset: text.length },
      });
    }
    const model = turn.origin.model ?? 'unknown';
    const provider = turn.origin.provider ?? turn.origin.harness ?? 'clikcode';
    for (const step of assistantSteps(turn, mcodeCall, callId)) {
      append('msg-', {
        role: 'assistant',
        content: [
          ...(step.text ? [{ type: 'text', text: step.text }] : []),
          ...step.calls.map((call) => ({ type: 'toolCall', id: call.id, name: call.name, arguments: call.args })),
        ],
        api: 'openai-completions', provider, model, usage: ZERO_USAGE,
        stopReason: step.calls.length ? 'toolUse' : 'stop',
      });
      for (const call of step.calls) {
        append('msg-', {
          role: 'toolResult', toolCallId: call.id, toolName: call.name,
          content: [{ type: 'text', text: callResultText(call.call) }],
          isError: call.call.status !== 'done',
        });
      }
    }
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** `03-22-02-883-session_<base64(id), unpadded>` under `YYYY/MM/DD` (UTC),
 *  as mcode names a session's directory. */
export function mcodeSessionRelativeDir(sessionId: string, now: Date): string {
  const iso = now.toISOString();
  const [date, time] = [iso.slice(0, 10), iso.slice(11, 23)];
  const encoded = Buffer.from(sessionId, 'utf8').toString('base64').replace(/=+$/, '');
  return `${date.replace(/-/g, '/')}/${time.replace(/[:.]/g, '-')}-session_${encoded}`;
}

type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: unknown[]): unknown; get(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] };
  close(): void;
};

/** sha256 of `[]`, the revision mcode records for a new session's history. */
const EMPTY_HISTORY_REVISION = `sha256:${createHash('sha256').update('[]').digest('hex')}`;

const SESSION_COLUMNS = [
  'session_id', 'record_json', 'updated_at_ms', 'columnar_version', 'agent_name', 'runtime', 'session_type', 'status',
  'archived', 'visibility', 'session_kind', 'workspace_dir', 'project_workspace_dir', 'is_default_workspace', 'title',
  'created_at_ms', 'extra_data_json', 'history_relative_dir',
];

const CHECKPOINT_COLUMNS = ['session_id', 'migrated_at_ms', 'source', 'message_count', 'target_revision'];

/** Registers the written directory as a session, the way mcode's own first
 *  turn leaves it. False when the database is not one this was verified on. */
async function registerSession(
  database: string, row: { sessionId: string; workspace: string; title: string; relativeDir: string; nowMs: number },
): Promise<boolean> {
  let db: Db | undefined;
  try {
    const sqlite = await import('node:sqlite') as { DatabaseSync: new (path: string) => Db };
    db = new sqlite.DatabaseSync(database);
    db.exec('PRAGMA busy_timeout = 3000');
    const have = (table: string): Set<string> => new Set((db!.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    const sessions = have('local_runtime_sessions');
    const checkpoints = have('local_runtime_pi_history_file_migrations');
    if (!SESSION_COLUMNS.every((name) => sessions.has(name))) return false;
    if (!CHECKPOINT_COLUMNS.every((name) => checkpoints.has(name))) return false;
    const { sessionId, workspace, nowMs } = row;
    const record = {
      sessionId, agentName: '__local_runtime_v2__', workspaceDir: workspace, runtime: 'pi-agent', sessionType: 'branch',
      archived: true, visibility: 'hidden', status: 'idle', createdAtMs: nowMs, updatedAtMs: nowMs,
    };
    const extra = { appMode: 'coding', origin: 'user', sessionDataVersion: 4, sessionOrigin: 'local-runtime' };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO local_runtime_sessions (${SESSION_COLUMNS.join(',')}) VALUES (${SESSION_COLUMNS.map(() => '?').join(',')})`).run(
        sessionId, JSON.stringify(record), nowMs, 3, 'mavis', 'pi-agent', 'branch', 'idle',
        0, 'visible', 'conversation', workspace, workspace, 0, row.title,
        nowMs, JSON.stringify(extra), row.relativeDir,
      );
      // The checkpoint mcode's own first turn leaves (nothing to migrate, the
      // revision of an empty history): without it mcode migrates history
      // into the file and refuses a non-empty one. Appends after it are
      // normal -- every mcode session grows past its checkpoint.
      db.prepare('INSERT INTO local_runtime_pi_history_file_migrations (session_id, migrated_at_ms, source, message_count, target_revision) VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, nowMs, 'empty', 0, EMPTY_HISTORY_REVISION);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return true;
  } finally {
    try { db?.close(); } catch { /* fail-open-ok: the insert already decided. */ }
  }
}

/** Verified against mcode 0.5.10 (2026-10-04, vendor-sandbox): see the
 *  module comment; live proof in the commit that added this. */
export const mcodeThreadWriter: NativeThreadWriter = {
  testedVersions: ['0.5.10'],
  versionOk: testedVersion(['0.5.10']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const dataDir = mcodeDataDir(context.environment);
    const database = join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
    if (!(await stat(database).then((s) => s.isFile(), () => false))) return undefined;
    const sessionId = `mvs_${randomUUID().replace(/-/g, '')}`;
    const now = new Date();
    const relativeDir = mcodeSessionRelativeDir(sessionId, now);
    const directory = join(mcodeRoot(context.environment), relativeDir);
    const text = mcodeThreadLines(record, { sessionId, now });
    await writeDirectoryAtomic(directory, { 'messages.jsonl': text });
    const title = record.turns.find((turn) => turn.user.trim())?.user.trim().replace(/\s+/g, ' ').slice(0, 120) ?? 'ClikCode conversation';
    const registered = await registerSession(database, {
      sessionId, workspace: context.workspace, title, relativeDir, nowMs: now.getTime(),
    }).catch(() => false);
    if (!registered) {
      await rm(directory, { recursive: true, force: true });
      return undefined;
    }
    return { nativeId: sessionId };
  },
};

/** The session's history directory, relative to the sessions root, as its
 *  row names it -- only a plain relative path, never one leaving the root. */
function historyDirectory(db: CarryDb, schema: CarrySchema, sessionId: string): string | undefined {
  const row = db.prepare(`SELECT history_relative_dir AS d FROM ${schema}.local_runtime_sessions WHERE session_id = ?`)
    .get(sessionId) as { d?: unknown } | undefined;
  const relative = typeof row?.d === 'string' ? row.d : undefined;
  if (!relative || isAbsolute(relative) || normalize(relative).split(/[\\/]/).includes('..')) return undefined;
  return relative;
}

/** One conversation in mcode 0.5.10 is the writer's three pieces: the
 *  `local_runtime_sessions` row, its `local_runtime_pi_history_file_migrations`
 *  checkpoint, and the history directory the row names (`messages.jsonl` and
 *  whatever mcode wrote beside it). Carried as one: the directory is staged
 *  and swapped in while the row transaction is open, and put back if it does
 *  not commit. `project_id` is the destination's own numbering, so it is left
 *  for mcode's insert trigger to assign.
 *
 *  Deliberately NOT carried: mcode's other per-session state (turn ingress
 *  sequences, agent state, token usage, turn diffs, the session search
 *  index). A session the writer made has none of it and resumes (live, 0.5.10),
 *  so the carried thread is at least that.
 *
 *  Progress is the lines of `messages.jsonl`: a resume only appends.
 *
 *  Verified against mcode 0.5.10 (2026-10-05, vendor-sandbox, ACP as ClikCode
 *  drives it, a custom provider pointed at a local stub model that answers
 *  only from the history it is sent -- both MiniMax sign-ins had expired, see
 *  below): a session made in profile A ("Remember the word HERONF8") was
 *  carried into a profile B holding its own session ('carried'; A and B's own
 *  session unchanged); the ACP resume in B sent both user turns and got
 *  HERONF8. After a second turn in B ("remember the number 200") it was
 *  carried back, and A's resume sent all four user turns: "HERONF8 200".
 *  Not yet seen on a MiniMax model: mcode 0.5.10 reports "Sign in to MiniMax
 *  to use Agent features" once its token expires (it did not refresh one). */
export const mcodeCarry: SqliteCarrySpec = {
  database: (environment) => join(mcodeDataDir(environment), 'v2', 'sqlite', 'runtime-state.sqlite'),
  session: { table: 'local_runtime_sessions', key: 'session_id', identity: ['created_at_ms'], omit: ['project_id'], parent: 'parent_session_id' },
  rows: [{ table: 'local_runtime_pi_history_file_migrations', key: 'session_id' }],
  required: { local_runtime_sessions: SESSION_COLUMNS, local_runtime_pi_history_file_migrations: CHECKPOINT_COLUMNS },
  async progress(db, schema, input) {
    const relative = historyDirectory(db, schema, input.nativeId);
    const root = mcodeRoot(schema === 'src' ? input.from : input.to);
    const text = relative ? await readFile(join(root, relative, 'messages.jsonl'), 'utf8').catch(() => undefined) : undefined;
    // A destination without the file holds nothing to keep.
    if (text === undefined) return schema === 'main' ? [] : undefined;
    return text.split('\n').filter((line) => line.trim());
  },
  async files(db, input) {
    const relative = historyDirectory(db, 'src', input.nativeId);
    if (!relative) return undefined;
    const source = join(mcodeRoot(input.from), relative);
    const target = join(mcodeRoot(input.to), relative);
    const tag = randomBytes(4).toString('hex');
    const staged = `${target}.${tag}.carry`;
    const displaced = `${target}.${tag}.old`;
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await cp(source, staged, { recursive: true });
    } catch {
      await rm(staged, { recursive: true, force: true });
      return undefined;
    }
    // A non-empty directory cannot be renamed over, so an older copy moves
    // aside first and is deleted only once the rows have committed.
    const had = await stat(target).then(() => true, () => false);
    try {
      if (had) await rename(target, displaced);
      await rename(staged, target);
    } catch {
      if (had && !await stat(target).then(() => true, () => false)) await rename(displaced, target).catch(() => undefined);
      await rm(staged, { recursive: true, force: true });
      return undefined;
    }
    return {
      commit: () => rm(displaced, { recursive: true, force: true }),
      async undo() {
        await rm(target, { recursive: true, force: true });
        if (had) await rename(displaced, target);
      },
    };
  },
};

export const mcodeSessionStore: NativeSessionStore = {
  root: mcodeRoot,
  carry: (input) => carrySqliteSession(mcodeCarry, input),
  writer: mcodeThreadWriter,
};

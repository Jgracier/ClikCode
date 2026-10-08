/** Hermes keeps every conversation as ROWS in one shared SQLite database.
 *
 * `<HERMES_HOME>/state.db`, defaulting to `~/.hermes/state.db` -- read out of
 * Hermes' own source (`Path(os.environ.get("HERMES_HOME", Path.home() /
 * ".hermes")) / "state.db"`), not guessed. That one file also holds the
 * account's other sessions, its gateway routing and its search indexes, so
 * copying it across profiles would overwrite everything the receiving account
 * had. This is the only vendor so far whose conversation is not separable as a
 * path, which is why the store carries it itself instead of naming a file.
 *
 * What one conversation actually is, at schema_version 26:
 *
 *   sessions             one row, keyed by id
 *   messages             the transcript, keyed by session_id
 *   session_model_usage  per-model token/cost rows, keyed by session_id
 *   system_prompts       content-addressed by hash, referenced by the session
 *
 * Nothing else is touched. `messages_fts` and `messages_fts_trigram` are left
 * alone deliberately: all six of their triggers fire on `messages`, so the
 * search indexes follow the rows and hand-maintaining them would only be a
 * chance to corrupt them.
 *
 * Column lists come from PRAGMA table_info at run time and the two schemas
 * must agree exactly, so a profile mid-migration aborts the carry rather than
 * writing mismatched rows. `messages.id` is AUTOINCREMENT and is deliberately
 * NOT carried -- the destination assigns its own, which is what stops a
 * collision with the messages it already has.
 *
 * INSERT OR REPLACE is never used, and that is the hard-won part. `sessions`
 * carries `idx_sessions_title_unique`, a UNIQUE index on `title`, and Hermes
 * numbers duplicate titles per database ("OK", "OK #2"), so two profiles
 * independently produce the same title all the time. A REPLACE therefore
 * deletes the destination account's OWN session that happened to share a
 * title -- observed doing exactly that in a prototype, which is what put the
 * title fallback below here. The index is partial (`WHERE title IS NOT NULL`),
 * so a NULL title is always accepted and Hermes re-titles the session itself.
 *
 * Verified: rows copied this way made `hermes sessions list` show the carried
 * thread in the receiving profile, and its ACP `session/load` succeed there
 * exactly as for a session that profile had created itself.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureNativeHarnessOutput } from '../../../harness/transport/native/command.js';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import {
  nativeDataRoot,
  type NativeSessionCarry, type NativeSessionEnvironment, type NativeSessionStore,
  type NativeThreadWriteContext, type NativeThreadWriter, type NativeThreadWritten,
} from '../stores.js';
import { importClaudeThread, type ClaudeImportSpec } from './claude-import.js';
import { testedVersion } from './thread-writer-files.js';
import {
  absolutePath, assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText,
} from './thread-writer-files.js';

type Db = {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown; get(...p: unknown[]): unknown };
  close(): void;
};

function databaseFor(environment: NativeSessionEnvironment): string {
  return join(nativeDataRoot(environment, 'HERMES_HOME', join(homedir(), '.hermes')), 'state.db');
}

/** Node 22 -- this package's floor -- only exposes node:sqlite behind
 *  --experimental-sqlite, so this import genuinely can fail. Carrying is an
 *  optimisation over re-seeding, so that is a clean "no" rather than an error. */
async function openSqlite(path: string): Promise<Db | undefined> {
  try {
    const sqlite = await import('node:sqlite') as { DatabaseSync: new (p: string) => Db };
    return new sqlite.DatabaseSync(path);
  } catch {
    return undefined;
  }
}

function columns(db: Db, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[])
    .map((row) => row.name);
}

/** Identical column lists, or undefined when the two profiles disagree. */
function sharedColumns(db: Db, table: string): string[] | undefined {
  const here = columns(db, 'main', table);
  const there = columns(db, 'src', table);
  if (!here.length || here.length !== there.length) return undefined;
  return here.every((name, index) => name === there[index]) ? here : undefined;
}

const quote = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(',');

async function carryHermesSession(input: NativeSessionCarry): Promise<boolean> {
  const source = databaseFor(input.from);
  const destination = databaseFor(input.to);
  if (source === destination) return true;
  const present = await Promise.all([stat(source), stat(destination)].map((p) => p.then(() => true, () => false)));
  // The destination database must already exist: creating one here would hand
  // the receiving account a store with no schema, which is worse than nothing.
  if (!present[0] || !present[1]) return false;

  const db = await openSqlite(destination);
  if (!db) return false;
  try {
    db.prepare('ATTACH DATABASE ? AS src').run(source);
    const sessions = sharedColumns(db, 'sessions');
    const messages = sharedColumns(db, 'messages');
    if (!sessions || !messages) return false;
    const id = input.nativeId;
    if (!(db.prepare('SELECT 1 FROM src.sessions WHERE id = ?').get(id))) return false;

    const countOf = (schema: string): number => Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.messages WHERE session_id = ?`).get(id) as { n: number }).n,
    );
    // A -> B -> A finds its own earlier copy waiting, one switch out of date.
    // A vendor transcript only grows, so more rows is the current one; an equal
    // or longer transcript already there is left exactly as it is.
    const incoming = countOf('src');
    if (!incoming) return false;
    if (countOf('main') >= incoming) return true;

    db.exec('BEGIN IMMEDIATE');
    try {
      // Order is forced by two foreign keys on `sessions`, both read off the
      // live schema rather than assumed: system_prompt_hash ->
      // system_prompts.hash, and parent_session_id -> sessions.id. So the
      // prompt has to land BEFORE the session row, and a parent the
      // destination has never seen has to be dropped rather than referenced.
      // Both show up only as "FOREIGN KEY constraint failed", which is how
      // they were found.
      const prompts = sharedColumns(db, 'system_prompts');
      if (prompts && sessions.includes('system_prompt_hash')) {
        db.prepare(
          `INSERT OR IGNORE INTO main.system_prompts (${quote(prompts)}) SELECT ${quote(prompts)} FROM src.system_prompts`
          + ' WHERE hash IN (SELECT system_prompt_hash FROM src.sessions WHERE id = ?)',
        ).run(id);
      }

      // Already there means this conversation came back (A -> B -> A): keep
      // the row the destination has and refresh only the transcript below.
      if (!db.prepare('SELECT 1 FROM main.sessions WHERE id = ?').get(id)) {
        const omit = new Set<string>();
        if (sessions.includes('parent_session_id')) {
          const parent = (db.prepare('SELECT parent_session_id AS p FROM src.sessions WHERE id = ?')
            .get(id) as { p?: string | null }).p;
          // A forked conversation whose parent stayed behind: carry the
          // conversation and let it stand alone rather than refusing it.
          if (parent && !db.prepare('SELECT 1 FROM main.sessions WHERE id = ?').get(parent)) {
            omit.add('parent_session_id');
          }
        }
        const keep = sessions.filter((name) => !omit.has(name));
        const insert = (names: readonly string[]): void => {
          // A plain INSERT on purpose: OR IGNORE would SUPPRESS the unique
          // title violation rather than raise it, so the fallback below could
          // never fire and the carry failed with the session row missing.
          db.prepare(
            `INSERT INTO main.sessions (${quote(names)}) SELECT ${quote(names)} FROM src.sessions WHERE id = ?`,
          ).run(id);
        };
        try {
          insert(keep);
        } catch {
          // The UNIQUE title index: keep the conversation, drop the name, and
          // let Hermes title it again. Never delete whatever holds that title.
          const withoutTitle = keep.filter((name) => name !== 'title');
          if (withoutTitle.length === keep.length) throw new Error('sessions insert failed');
          insert(withoutTitle);
        }
      }

      // Scoped to this conversation, so the receiving account's other
      // transcripts are untouched -- and the fts triggers follow along.
      const carried = messages.filter((name) => name !== 'id');
      db.prepare('DELETE FROM main.messages WHERE session_id = ?').run(id);
      db.prepare(
        `INSERT INTO main.messages (${quote(carried)}) SELECT ${quote(carried)} FROM src.messages WHERE session_id = ? ORDER BY id`,
      ).run(id);

      const usage = sharedColumns(db, 'session_model_usage');
      if (usage) {
        db.prepare('DELETE FROM main.session_model_usage WHERE session_id = ?').run(id);
        db.prepare(
          `INSERT INTO main.session_model_usage (${quote(usage)}) SELECT ${quote(usage)} FROM src.session_model_usage WHERE session_id = ?`,
        ).run(id);
      }
      db.exec('COMMIT');
      return true;
    } catch {
      db.exec('ROLLBACK');
      return false;
    }
  } catch {
    return false;
  } finally {
    try { db.close(); } catch { /* fail-open-ok: the carry already decided. */ }
  }
}

// ------------------------------------------------------ thread writer ----

/** A call in Hermes' own tools (tools/*.py, 0.20.5): `terminal`, `read_file`,
 *  `patch` (mode "replace"), `write_file`, `search_files`, `web_extract`,
 *  `web_search` -- their argument names as Hermes records them. */
function hermesCall(workspace: string) {
  return (call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined => {
    const path = callPath(call);
    const file = path ? absolutePath(workspace, path) : undefined;
    const name = call.name.toLowerCase();
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|terminal|run_shell_command|shell_command)$/.test(name))) {
      const command = callCommand(call);
      return command ? { name: 'terminal', args: { command } } : undefined;
    }
    if (call.category === 'read' && file) return { name: 'read_file', args: { path: file } };
    if (call.category === 'edit' && file) {
      if (isWriteCall(call)) return { name: 'write_file', args: { path: file, content: inputString(call, 'content', 'file_text', 'text') ?? '' } };
      const oldString = inputString(call, 'old_string', 'oldText', 'old_str');
      const newString = inputString(call, 'new_string', 'newText', 'new_str');
      return oldString !== undefined && newString !== undefined
        ? { name: 'patch', args: { mode: 'replace', path: file, old_string: oldString, new_string: newString } } : undefined;
    }
    if (call.category === 'search') {
      const pattern = inputString(call, 'pattern', 'query', 'regex', 'glob') ?? call.target;
      if (!pattern) return undefined;
      const where = inputString(call, 'path', 'dir_path', 'directory');
      return { name: 'search_files', args: {
        pattern, target: /glob|find|list|ls/.test(name) ? 'files' : 'content', path: absolutePath(workspace, where ?? '.'),
      } };
    }
    if (call.category === 'fetch') {
      const url = inputString(call, 'url', 'uri');
      if (url) return { name: 'web_extract', args: { urls: [url] } };
      const query = inputString(call, 'query', 'q') ?? call.target;
      return query ? { name: 'web_search', args: { query } } : undefined;
    }
    return undefined;
  };
}

/** A tool result in the JSON shape the same Hermes tool returns. */
function hermesResult(name: string, call: CanonicalToolCall, args: Record<string, unknown>): string {
  const text = callResultText(call);
  const failed = call.status !== 'done';
  switch (name) {
    case 'terminal': return JSON.stringify({ output: text, exit_code: call.exitCode ?? (failed ? 1 : 0), error: null });
    case 'read_file': return JSON.stringify({ content: text });
    case 'patch': return JSON.stringify({ success: !failed, diff: text });
    case 'write_file': return JSON.stringify(failed ? { error: text } : { bytes_written: Buffer.byteLength(String(args.content ?? ''), 'utf8'), files_modified: [args.path] });
    case 'search_files': return JSON.stringify({ matches_text: text });
    default: return JSON.stringify({ output: text });
  }
}

export interface HermesThreadOptions {
  sessionId: string;
  workspace: string;
  model: string | null;
  now: Date;
  callId?: () => string;
}

export interface HermesThreadRows {
  session: Record<string, unknown>;
  messages: Record<string, unknown>[];
}

/** The conversation as Hermes' own `sessions` row and `messages` rows: one
 *  user row per request, one assistant row per model response with its
 *  `tool_calls` (OpenAI shape plus the `call_id`/`response_item_id` Hermes
 *  stores for Responses-API providers), and a `tool` row per result. The
 *  session is `source: 'acp'` -- the only source Hermes' ACP agent restores
 *  (acp_adapter/session.py `_restore`); its CLI `--resume` takes any. */
export function hermesThreadRows(record: CanonicalRecord, options: HermesThreadOptions): HermesThreadRows {
  const callId = options.callId ?? (() => `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`);
  const start = options.now.getTime() / 1000;
  let tick = 0;
  const stamp = (): number => start + (tick++) / 1000;
  const map = hermesCall(options.workspace);
  const messages: Record<string, unknown>[] = [];
  let calls = 0;
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !messages.length) messages.push({ role: 'user', content: request.trim() ? request : '(continue)', timestamp: stamp() });
    for (const step of assistantSteps(turn, map, callId)) {
      calls += step.calls.length;
      messages.push({
        role: 'assistant', content: step.text, timestamp: stamp(),
        finish_reason: step.calls.length ? 'tool_calls' : 'stop',
        ...(step.calls.length ? { tool_calls: JSON.stringify(step.calls.map((call) => ({
          id: call.id, call_id: call.id, response_item_id: `fc_${call.id}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }))) } : {}),
      });
      for (const call of step.calls) {
        messages.push({ role: 'tool', content: hermesResult(call.name, call.call, call.args), tool_call_id: call.id, tool_name: call.name, timestamp: stamp() });
      }
    }
  }
  const workspace = resolve(options.workspace);
  return {
    session: {
      id: options.sessionId, source: 'acp', model: options.model, model_config: JSON.stringify({ cwd: workspace }),
      cwd: workspace, started_at: start, last_activity_at: start + Math.max(0, tick - 1) / 1000,
      message_count: messages.length, tool_call_count: calls,
    },
    messages,
  };
}

export const HERMES_IMPORT_SPEC: ClaudeImportSpec = {
  testedVersions: ['0.20.5'],
  toolCalls: 'text',
  transport: 'text-cli',
  argv: (file) => ['sessions', 'import', '--from', 'claude', file],
  parse: (output) => /Imported Claude Code session as (\S+)/.exec(output)?.[1],
};

/** Columns a written thread needs; a schema without them is not one this
 *  writer was verified on. */
const SESSION_COLUMNS = ['id', 'source', 'model', 'model_config', 'cwd', 'started_at', 'last_activity_at', 'message_count', 'tool_call_count'];
const MESSAGE_COLUMNS = ['session_id', 'role', 'content', 'tool_call_id', 'tool_calls', 'tool_name', 'timestamp', 'finish_reason'];

async function writeHermesThread(record: CanonicalRecord, context: NativeThreadWriteContext): Promise<NativeThreadWritten | undefined> {
  if (!record.turns.length) return undefined;
  const database = databaseFor(context.environment);
  // A profile Hermes has never run in has no database yet: Hermes creates
  // its own schema on any command, so the thread lands in exactly the
  // layout it reads.
  if (!await stat(database).then(() => true, () => false)) {
    await captureNativeHarnessOutput(context.harness, ['sessions', 'list', '--limit', '1'], context.environment, 60_000, context.workspace).catch(() => undefined);
    if (!await stat(database).then(() => true, () => false)) return undefined;
  }
  const db = await openSqlite(database);
  // No node:sqlite in this runtime: Hermes' own importer still gets the
  // conversation in, without real tool calls and on the CLI only.
  if (!db) return importClaudeThread(record, context, HERMES_IMPORT_SPEC);
  try {
    const sessionColumns = new Set(columns(db, 'main', 'sessions'));
    const messageColumns = new Set(columns(db, 'main', 'messages'));
    if (!SESSION_COLUMNS.every((name) => sessionColumns.has(name)) || !MESSAGE_COLUMNS.every((name) => messageColumns.has(name))) return undefined;
    const sessionId = randomUUID();
    const rows = hermesThreadRows(record, { sessionId, workspace: context.workspace, model: context.model, now: new Date() });
    const insert = (table: string, row: Record<string, unknown>): void => {
      const names = Object.keys(row).filter((name) => row[name] !== undefined && row[name] !== null);
      db.prepare(`INSERT INTO ${table} (${quote(names)}) VALUES (${names.map(() => '?').join(',')})`)
        .run(...names.map((name) => row[name]));
    };
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      insert('sessions', rows.session);
      for (const message of rows.messages) insert('messages', { session_id: sessionId, ...message });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { nativeId: sessionId };
  } finally {
    try { db.close(); } catch { /* fail-open-ok: the write already decided. */ }
  }
}

/** Verified on Hermes 0.20.5 (2026-10-04, vendor-sandbox): see the store's
 *  `writer` below. */
export const hermesThreadWriter: NativeThreadWriter = {
  testedVersions: HERMES_IMPORT_SPEC.testedVersions,
  versionOk: (context) => testedVersion(HERMES_IMPORT_SPEC.testedVersions)(context),
  write: writeHermesThread,
};

export const hermesSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    return nativeDataRoot(environment, 'HERMES_HOME', join(homedir(), '.hermes'));
  },
  carry: carryHermesSession,
  /** The thread is written straight into Hermes' own state.db
   *  (hermesThreadRows): real tool calls, resumable by ACP `session/load`
   *  and CLI `--resume` alike, so nothing is pinned. Hermes' importer
   *  (`hermes sessions import --from claude`) is only the fallback for a
   *  runtime without node:sqlite: it folds a turn into ONE assistant row,
   *  keeps a tool_use only as `[ran tool: Bash]`, and its imports are not
   *  `source: 'acp'`, so ACP answers "session not found" (CLI only). */
  writer: hermesThreadWriter,
};

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

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  nativeDataRoot,
  type NativeSessionCarry, type NativeSessionEnvironment, type NativeSessionStore,
} from '../stores.js';

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

export const hermesSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    return nativeDataRoot(environment, 'HERMES_HOME', join(homedir(), '.hermes'));
  },
  carry: carryHermesSession,
};

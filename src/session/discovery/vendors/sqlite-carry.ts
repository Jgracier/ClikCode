/** Carrying one conversation that lives as ROWS in a vendor's shared SQLite
 * database (NativeSessionStore.carry), for OpenCode/Kilo, Goose, Devin and
 * MiniMax Code. Hermes (hermes-store.ts) was the first and keeps its own,
 * because its UNIQUE title index needs a fallback no other vendor has.
 *
 * The database also holds the receiving account's other sessions, so it is
 * never copied: the destination opens its own database, ATTACHes the
 * source's, and copies this one session's rows across in ONE transaction
 * (BEGIN IMMEDIATE, behind the same busy timeout the writers use, so a vendor
 * process writing the database waits for it or it waits for them). Anything
 * uncertain -- a table whose columns differ between the two profiles (one is
 * mid-migration), a column the writer relies on missing, a session the source
 * does not have -- returns false with both databases untouched, and the
 * caller re-seeds.
 *
 * Which copy wins. A conversation that went A -> B -> A finds its own older
 * copy waiting in A. Each store names the conversation's progress as an
 * ordered list (message ids, chain nodes, transcript lines):
 *
 *   destination a prefix of (or equal to) the source  -> replaced by it
 *   source a strict prefix of the destination         -> left alone (newer)
 *   neither                                           -> false
 *
 * and a destination row with the same id must also agree on the session's
 * `identity` columns (when it was created): Goose numbers its sessions per
 * database (`20261005_1`), so the same id in another profile can be a
 * different conversation, and that one is never overwritten.
 *
 * Only this session's rows move: the session row is UPSERTed (never deleted,
 * so no ON DELETE CASCADE reaches anything), and each per-session table has
 * this session's rows deleted and re-inserted, parents first. AUTOINCREMENT
 * ids are left to the destination (`omit`), which is what keeps them from
 * colliding with its own rows. */

import { stat } from 'node:fs/promises';
import type { NativeSessionCarry, NativeSessionEnvironment } from '../stores.js';

type Statement = { all(...values: unknown[]): unknown[]; get(...values: unknown[]): unknown; run(...values: unknown[]): unknown };
export type CarryDb = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };
export type CarrySchema = 'main' | 'src';

/** A table holding the session's rows, keyed by the column naming it. */
export interface SqliteCarryTable {
  table: string;
  key: string;
  /** Columns the destination assigns itself (AUTOINCREMENT ids). */
  omit?: readonly string[];
  /** ORDER BY for the copy, so newly assigned ids keep the original order. */
  order?: string;
}

/** What a vendor's conversation is in its database. */
export interface SqliteCarrySpec {
  database(environment: NativeSessionEnvironment): string;
  session: SqliteCarryTable & {
    /** Columns that must match a same-id row already in the destination. */
    identity: readonly string[];
    /** A column naming another session, cleared when the destination has no
     *  such session (a fork whose parent stayed behind). */
    parent?: string;
  };
  /** Per-session tables, parents first. A table absent from both databases
   *  is skipped (an older build); one in only one of them aborts. */
  rows: readonly SqliteCarryTable[];
  /** Rows the session refers to and other sessions share (OpenCode's
   *  project): copied only when the destination has none under that key.
   *  `via` is the session column holding the key. */
  shared?: readonly { table: string; key: string; via: string }[];
  /** Columns the store's writer relies on: a schema without them is not one
   *  this was verified on. */
  required?: Readonly<Record<string, readonly string[]>>;
  /** The conversation so far, oldest first, in one database: undefined when
   *  it cannot be read. */
  progress(db: CarryDb, schema: CarrySchema, input: NativeSessionCarry): string[] | undefined | Promise<string[] | undefined>;
  /** Files the session keeps beside the database (MiniMax Code's history
   *  directory). Called inside the open transaction once the rows are
   *  written: put the files in place and return how to finish or undo that,
   *  or undefined to abort the carry. */
  files?(db: CarryDb, input: NativeSessionCarry): Promise<{ commit(): Promise<void>; undo(): Promise<void> } | undefined>;
}

/** Progress as a query: `{db}` is the schema, `?` the session id, and the
 *  one column `k` an entry. */
export function progressQuery(sql: string): SqliteCarrySpec['progress'] {
  return (db, schema, input) => (db.prepare(sql.replaceAll('{db}', schema)).all(input.nativeId) as { k: unknown }[])
    .map((row) => String(row.k));
}

/** Node 22 -- this package's floor -- has node:sqlite only behind
 *  --experimental-sqlite; without it a carry is a clean "no". */
export async function openCarryDatabase(path: string): Promise<CarryDb | undefined> {
  try {
    const sqlite = await import('node:sqlite') as unknown as { DatabaseSync: new (path: string) => CarryDb };
    return new sqlite.DatabaseSync(path);
  } catch {
    return undefined;
  }
}

function columns(db: CarryDb, schema: CarrySchema, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all() as { name: string }[]).map((row) => row.name);
}

/** The table's columns when both databases agree on them exactly; [] when
 *  neither has the table; undefined when they disagree. */
function sharedColumns(db: CarryDb, table: string): string[] | undefined {
  const here = columns(db, 'main', table);
  const there = columns(db, 'src', table);
  if (here.length !== there.length) return undefined;
  return here.every((name, index) => name === there[index]) ? here : undefined;
}

const quote = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(',');
const isPrefix = (short: readonly string[], long: readonly string[]): boolean =>
  short.length <= long.length && short.every((entry, index) => entry === long[index]);

export async function carrySqliteSession(spec: SqliteCarrySpec, input: NativeSessionCarry): Promise<boolean> {
  const source = spec.database(input.from);
  const destination = spec.database(input.to);
  if (source === destination) return true;
  const present = await Promise.all([source, destination].map((path) => stat(path).then((entry) => entry.isFile(), () => false)));
  // A destination with no database is a profile the vendor never ran in:
  // creating one here would hand it a store with no schema.
  if (!present[0] || !present[1]) return false;
  const db = await openCarryDatabase(destination);
  if (!db) return false;
  const id = input.nativeId;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('ATTACH DATABASE ? AS src').run(source);
    const { session } = spec;
    const sessionColumns = sharedColumns(db, session.table);
    if (!sessionColumns?.length) return false;
    const tables: Array<{ spec: SqliteCarryTable; names: string[] }> = [];
    for (const table of spec.rows) {
      const names = sharedColumns(db, table.table);
      if (!names) return false;
      if (names.length) tables.push({ spec: table, names: names.filter((name) => !table.omit?.includes(name)) });
    }
    const shared: Array<{ table: string; key: string; via: string; names: string[] }> = [];
    for (const table of spec.shared ?? []) {
      const names = sharedColumns(db, table.table);
      if (!names) return false;
      if (names.length) shared.push({ ...table, names });
    }
    for (const [table, required] of Object.entries(spec.required ?? {})) {
      const names = new Set(columns(db, 'main', table));
      if (!required.every((name) => names.has(name))) return false;
    }

    const rowOf = (schema: CarrySchema): Record<string, unknown> | undefined =>
      db.prepare(`SELECT * FROM ${schema}."${session.table}" WHERE "${session.key}" = ?`).get(id) as Record<string, unknown> | undefined;

    db.exec('BEGIN IMMEDIATE');
    let swap: { commit(): Promise<void>; undo(): Promise<void> } | undefined;
    try {
      const incomingRow = rowOf('src');
      const incoming = incomingRow ? await spec.progress(db, 'src', input) : undefined;
      if (!incomingRow || !incoming?.length) throw new Declined();
      const existing = rowOf('main');
      if (existing) {
        if (!session.identity.every((name) => existing[name] === incomingRow[name])) throw new Declined();
        const current = await spec.progress(db, 'main', input) ?? [];
        if (current.length > incoming.length && isPrefix(incoming, current)) {
          // Further along already: everything the source has, and more.
          db.exec('ROLLBACK');
          return true;
        }
        if (!isPrefix(current, incoming)) throw new Declined();
      }

      for (const table of shared) {
        db.prepare(
          `INSERT OR IGNORE INTO main."${table.table}" (${quote(table.names)}) SELECT ${quote(table.names)} FROM src."${table.table}"`
          + ` WHERE "${table.key}" = (SELECT "${table.via}" FROM src."${session.table}" WHERE "${session.key}" = ?)`,
        ).run(id);
      }
      // Children first, so no foreign key is left pointing at a deleted row.
      for (const { spec: table } of [...tables].reverse()) {
        db.prepare(`DELETE FROM main."${table.table}" WHERE "${table.key}" = ?`).run(id);
      }
      const names = sessionColumns.filter((name) => !session.omit?.includes(name));
      const updates = names.filter((name) => name !== session.key).map((name) => `"${name}" = excluded."${name}"`);
      db.prepare(
        `INSERT INTO main."${session.table}" (${quote(names)}) SELECT ${quote(names)} FROM src."${session.table}" WHERE "${session.key}" = ?`
        + ` ON CONFLICT("${session.key}") DO ${updates.length ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'}`,
      ).run(id);
      if (session.parent) {
        db.prepare(
          `UPDATE main."${session.table}" SET "${session.parent}" = NULL WHERE "${session.key}" = ? AND "${session.parent}" IS NOT NULL`
          + ` AND "${session.parent}" NOT IN (SELECT "${session.key}" FROM main."${session.table}")`,
        ).run(id);
      }
      for (const { spec: table, names: carried } of tables) {
        db.prepare(
          `INSERT INTO main."${table.table}" (${quote(carried)}) SELECT ${quote(carried)} FROM src."${table.table}"`
          + ` WHERE "${table.key}" = ?${table.order ? ` ORDER BY ${table.order}` : ''}`,
        ).run(id);
      }
      if (spec.files) {
        swap = await spec.files(db, input);
        if (!swap) throw new Declined();
      }
      db.exec('COMMIT');
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* fail-open-ok: no transaction left to roll back. */ }
      await swap?.undo().catch(() => undefined);
      return false;
    }
    await swap?.commit().catch(() => undefined);
    return true;
  } catch {
    return false;
  } finally {
    try { db.close(); } catch { /* fail-open-ok: the carry already decided. */ }
  }
}

/** Not an error: the carry decided against it. */
class Declined extends Error {}

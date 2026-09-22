import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hermesSessionStore } from './hermes-store';

/** node:sqlite needs --experimental-sqlite on this package's Node 22 floor,
 *  and the store is written to decline rather than throw when it is missing --
 *  so these tests only mean anything where it loads. */
const sqlite = await import('node:sqlite').then((m) => m, () => undefined);

/** The parts of Hermes' schema_version 26 that the carry has to respect: the
 *  UNIQUE index on title (partial, so NULL is always allowed), and both
 *  foreign keys on sessions. Trimmed to the carried columns -- the real table
 *  has 56 -- because what is being tested is the constraints, not the width. */
const SCHEMA = [
  `CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL)`,
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT,
     system_prompt_hash TEXT REFERENCES system_prompts(hash),
     parent_session_id TEXT REFERENCES sessions(id),
     started_at REAL NOT NULL, message_count INTEGER DEFAULT 0)`,
  `CREATE UNIQUE INDEX idx_sessions_title_unique ON sessions(title) WHERE title IS NOT NULL`,
  `CREATE TABLE messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id),
     role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL)`,
  `CREATE TABLE session_model_usage (
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     model TEXT NOT NULL)`,
];

type Row = Record<string, unknown>;

async function profile(name: string, build: (db: any) => void): Promise<string> {
  const home = join(await mkdtemp(join(tmpdir(), 'clikcode-hermes-')), name);
  await mkdir(home, { recursive: true });
  const db = new (sqlite as any).DatabaseSync(join(home, 'state.db'));
  for (const statement of SCHEMA) db.exec(statement);
  build(db);
  db.close();
  return home;
}

function read(home: string, sql: string): Row[] {
  const db = new (sqlite as any).DatabaseSync(join(home, 'state.db'));
  try { return db.prepare(sql).all() as Row[]; } finally { db.close(); }
}

const session = (db: any, id: string, title: string | null, hash: string | null, parent: string | null = null) => {
  if (hash) db.exec(`INSERT OR IGNORE INTO system_prompts VALUES ('${hash}','be helpful')`);
  db.prepare('INSERT INTO sessions (id,source,title,system_prompt_hash,parent_session_id,started_at,message_count) VALUES (?,?,?,?,?,?,?)')
    .run(id, 'cli', title, hash, parent, 1, 0);
};
const message = (db: any, id: string, role: string, content: string) =>
  db.prepare('INSERT INTO messages (session_id,role,content,timestamp) VALUES (?,?,?,?)').run(id, role, content, 1);

describe.skipIf(!sqlite)('hermes carries one conversation out of a shared database', () => {
  it('carries the rows and never touches the destination account\'s own sessions', async () => {
    const from = await profile('a', (db) => {
      session(db, 'conv-a', 'Fix the parser', 'hash-1');
      message(db, 'conv-a', 'user', 'what is 2+2?');
      message(db, 'conv-a', 'assistant', '4');
      db.exec(`INSERT INTO session_model_usage VALUES ('conv-a','hermes-4')`);
    });
    const to = await profile('b', (db) => {
      session(db, 'conv-b-own', 'Something else', null);
      message(db, 'conv-b-own', 'user', 'the other account\'s own work');
    });

    await expect(hermesSessionStore.carry!({ nativeId: 'conv-a', workspace: '/w', from: { HERMES_HOME: from }, to: { HERMES_HOME: to } }))
      .resolves.toBe(true);

    expect(read(to, 'SELECT id FROM sessions ORDER BY id').map((r) => r.id)).toEqual(['conv-a', 'conv-b-own']);
    expect(read(to, `SELECT content FROM messages WHERE session_id='conv-a' ORDER BY id`).map((r) => r.content))
      .toEqual(['what is 2+2?', '4']);
    // Untouched.
    expect(read(to, `SELECT content FROM messages WHERE session_id='conv-b-own'`)).toHaveLength(1);
    expect(read(to, `SELECT model FROM session_model_usage WHERE session_id='conv-a'`).map((r) => r.model)).toEqual(['hermes-4']);
    // The prompt has to land before the session row that references it.
    expect(read(to, 'SELECT hash FROM system_prompts').map((r) => r.hash)).toEqual(['hash-1']);
  });

  it('drops the title on a collision rather than deleting what holds it', async () => {
    // Hermes numbers duplicate titles per database ("OK", "OK #2"), so two
    // profiles independently produce the same title routinely. A prototype
    // using INSERT OR REPLACE deleted the destination's own session here.
    const from = await profile('a', (db) => {
      session(db, 'conv-a', 'OK', null);
      message(db, 'conv-a', 'user', 'carried');
    });
    const to = await profile('b', (db) => {
      session(db, 'conv-b-own', 'OK', null);
      message(db, 'conv-b-own', 'user', 'kept');
    });

    await expect(hermesSessionStore.carry!({ nativeId: 'conv-a', workspace: '/w', from: { HERMES_HOME: from }, to: { HERMES_HOME: to } }))
      .resolves.toBe(true);

    const rows = read(to, 'SELECT id,title FROM sessions ORDER BY id');
    expect(rows).toEqual([{ id: 'conv-a', title: null }, { id: 'conv-b-own', title: 'OK' }]);
    expect(read(to, `SELECT content FROM messages WHERE session_id='conv-b-own'`).map((r) => r.content)).toEqual(['kept']);
  });

  it('carries a forked conversation whose parent stayed behind', async () => {
    const from = await profile('a', (db) => {
      session(db, 'conv-parent', 'Parent', null);
      session(db, 'conv-fork', 'Fork', null, 'conv-parent');
      message(db, 'conv-fork', 'user', 'forked');
    });
    const to = await profile('b', () => { /* empty store */ });

    await expect(hermesSessionStore.carry!({ nativeId: 'conv-fork', workspace: '/w', from: { HERMES_HOME: from }, to: { HERMES_HOME: to } }))
      .resolves.toBe(true);
    // Stands alone rather than being refused for a parent that is not there.
    expect(read(to, 'SELECT id,parent_session_id FROM sessions')).toEqual([{ id: 'conv-fork', parent_session_id: null }]);
  });

  it('leaves a longer transcript already there alone, and does not duplicate on a repeat', async () => {
    const from = await profile('a', (db) => {
      session(db, 'conv-a', 'A', null);
      message(db, 'conv-a', 'user', 'one');
    });
    const to = await profile('b', (db) => {
      // Same conversation, further along: it went A -> B -> A.
      session(db, 'conv-a', 'A', null);
      message(db, 'conv-a', 'user', 'one');
      message(db, 'conv-a', 'assistant', 'two');
    });

    await expect(hermesSessionStore.carry!({ nativeId: 'conv-a', workspace: '/w', from: { HERMES_HOME: from }, to: { HERMES_HOME: to } }))
      .resolves.toBe(true);
    expect(read(to, `SELECT content FROM messages WHERE session_id='conv-a' ORDER BY id`).map((r) => r.content))
      .toEqual(['one', 'two']);
  });

  it('declines rather than creating a store the receiving account has no schema for', async () => {
    const from = await profile('a', (db) => {
      session(db, 'conv-a', 'A', null);
      message(db, 'conv-a', 'user', 'one');
    });
    const missing = join(await mkdtemp(join(tmpdir(), 'clikcode-hermes-')), 'nothing-here');
    await expect(hermesSessionStore.carry!({ nativeId: 'conv-a', workspace: '/w', from: { HERMES_HOME: from }, to: { HERMES_HOME: missing } }))
      .resolves.toBe(false);
  });

  it('declines a conversation the source does not have', async () => {
    const from = await profile('a', () => { /* empty */ });
    const to = await profile('b', () => { /* empty */ });
    await expect(hermesSessionStore.carry!({ nativeId: 'absent', workspace: '/w', from: { HERMES_HOME: from }, to: { HERMES_HOME: to } }))
      .resolves.toBe(false);
  });
});

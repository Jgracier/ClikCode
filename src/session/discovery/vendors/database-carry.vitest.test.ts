/** Carrying one conversation between two account profiles whose vendor keeps
 * every conversation as rows in one shared database (sqlite-carry.ts):
 * OpenCode/Kilo, Goose, Devin and MiniMax Code -- and Cursor, whose session
 * is a directory and is carried as one once verified.
 *
 * Each case: a source profile holding two sessions (written by the store's
 * own writer where the writer writes the database itself), a target holding
 * an unrelated session of its own. One session is carried; it must arrive
 * whole, the target's own session and the source must be exactly as they
 * were, and a session the source does not have writes nothing. Schemas are
 * the vendors' own DDL, read from databases each made in vendor-sandbox
 * (opencode 1.18.32, goose 1.51.0, devin 3000.11.3, mcode 0.5.10), trimmed
 * to the tables a carry touches. */

import { appendFile, mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import type { CanonicalOrigin, CanonicalPart, CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { carryNativeSession } from '../../carry.js';
import { NATIVE_SESSION_STORES } from '../registry.js';
import type { NativeSessionCarry, NativeThreadWriteContext } from '../stores.js';
import { openCodeExport } from './opencode-writer.js';
import { CURSOR_CARRY_VERIFIED, cursorAcpSessionsRoot, cursorStore, locateCursorSession, writeCursorStore } from './cursor-writer.js';

const sqlite = await import('node:sqlite').then((m) => m, () => undefined);
type Db = { exec(sql: string): void; prepare(sql: string): { all(...v: unknown[]): unknown[]; get(...v: unknown[]): unknown; run(...v: unknown[]): unknown }; close(): void };
const open = (file: string): Db => new (sqlite as unknown as { DatabaseSync: new (path: string) => Db }).DatabaseSync(file);

const WORKSPACE = '/home/user/projects/app';

function record(codeword: string): CanonicalRecord {
  const origin: CanonicalOrigin = { sessionId: 's', harness: 'codex', route: 'native' as CanonicalOrigin['route'], provider: 'openai', model: 'gpt-5.5' };
  const shell: CanonicalToolCall = {
    id: 'call_1', category: 'run', name: 'shell', input: { command: 'cat notes.txt' }, label: '$ cat notes.txt',
    target: 'cat notes.txt', status: 'done', output: ['launch window: Thursday'], exitCode: 0, files: [],
  };
  const parts: CanonicalPart[] = [
    { type: 'text', text: 'Reading the notes.' }, { type: 'tool', call: shell }, { type: 'text', text: `Noted ${codeword}.` },
  ];
  return {
    version: 1, conversationId: `conv-${codeword}`, sessionId: 's', workspace: WORKSPACE, touchedFiles: [], attachments: [],
    pendingAttachments: [], openTodos: [],
    turns: [{
      index: 0, user: `Remember the codeword ${codeword}.`, attachments: [], parts, interrupted: false, origin,
      tools: [shell], assistant: `Reading the notes.Noted ${codeword}.`, touchedFiles: [],
    }],
  };
}

/** Every row of every table, ordered: equal snapshots mean nothing changed. */
function snapshot(file: string): string {
  const db = open(file);
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    return JSON.stringify(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all()]));
  } finally {
    db.close();
  }
}

function rows(file: string, sql: string, ...values: unknown[]): Record<string, unknown>[] {
  const db = open(file);
  try { return db.prepare(sql).all(...values) as Record<string, unknown>[]; } finally { db.close(); }
}

async function database(file: string, schema: readonly string[]): Promise<string> {
  await mkdir(join(file, '..'), { recursive: true });
  const db = open(file);
  for (const statement of schema) db.exec(statement);
  db.close();
  return file;
}

async function homes(name: string): Promise<{ a: string; b: string; env: (home: string) => Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), `clikcode-${name}-carry-`));
  return {
    a: join(root, 'account-a'), b: join(root, 'account-b'),
    env: (home) => ({ HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CONFIG_HOME: join(home, '.config') }),
  };
}

function carryInput(env: (home: string) => Record<string, string>, from: string, to: string, nativeId: string): NativeSessionCarry {
  return { nativeId, workspace: WORKSPACE, from: env(from), to: env(to) };
}

// ------------------------------------------------------------- OpenCode ----

const OPENCODE_SCHEMA = [
  `CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text, icon_url text, icon_url_override text,
    icon_color text, time_created integer NOT NULL, time_updated integer NOT NULL, time_initialized integer, sandboxes text NOT NULL, commands text)`,
  `CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL,
    directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer,
    summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL,
    tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
    tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text,
    agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer,
    CONSTRAINT fk_session_project_id_project_id_fk FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE)`,
  `CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
    data text NOT NULL, CONSTRAINT fk_message_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE)`,
  `CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL,
    time_updated integer NOT NULL, data text NOT NULL,
    CONSTRAINT fk_part_message_id_message_id_fk FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE)`,
  `CREATE TABLE todo (session_id text NOT NULL, content text NOT NULL, status text NOT NULL, priority text NOT NULL,
    position integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
    CONSTRAINT todo_pk PRIMARY KEY(session_id, position),
    CONSTRAINT fk_todo_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE)`,
  `CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text)`,
  `CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL,
    CONSTRAINT fk_event_aggregate_id_event_sequence_aggregate_id_fk FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE)`,
  'CREATE UNIQUE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq)',
];

/** The writer's export, inserted the way `opencode import` stores it. */
function insertOpenCodeSession(file: string, codeword: string, startMs: number): string {
  const exported = openCodeExport(record(codeword), { workspace: WORKSPACE, model: 'opencode/big-pickle', version: '1.18.32', startMs });
  const db = open(file);
  try {
    const info = exported.info as { id: string; slug: string; title: string; time: { created: number; updated: number } };
    db.exec(`INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', 1, 1, '[]')`);
    db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)')
      .run(info.id, 'global', info.slug, WORKSPACE, info.title, '1.18.32', info.time.created, info.time.updated);
    let seq = 0;
    db.prepare('INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, 0)').run(info.id);
    const event = db.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?,?,?,?,?)');
    for (const message of exported.messages) {
      const { id, sessionID: _s, ...data } = message.info as { id: string; sessionID: string; time: { created: number } };
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
        .run(id, info.id, data.time.created, data.time.created, JSON.stringify(data));
      event.run(`evt_${id}`, info.id, seq++, 'message.updated.1', JSON.stringify({ id }));
      for (const part of message.parts) {
        const { id: partId, sessionID: _ps, messageID: _pm, ...partData } = part as { id: string; sessionID: string; messageID: string };
        db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
          .run(partId, id, info.id, data.time.created, data.time.created, JSON.stringify(partData));
      }
    }
    db.prepare('UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?').run(seq - 1, info.id);
    db.prepare('INSERT INTO todo VALUES (?,?,?,?,?,?,?)').run(info.id, `ship ${codeword}`, 'pending', 'high', 0, 1, 1);
    return info.id;
  } finally {
    db.close();
  }
}

const sessionRows = (file: string, id: string): string => JSON.stringify([
  rows(file, 'SELECT * FROM session WHERE id = ?', id),
  rows(file, 'SELECT * FROM message WHERE session_id = ? ORDER BY id', id),
  rows(file, 'SELECT * FROM part WHERE session_id = ? ORDER BY id', id),
  rows(file, 'SELECT * FROM todo WHERE session_id = ?', id),
  rows(file, 'SELECT * FROM event_sequence WHERE aggregate_id = ?', id),
  rows(file, 'SELECT * FROM event WHERE aggregate_id = ? ORDER BY seq', id),
]);

describe.skipIf(!sqlite)('opencode carries one session out of a shared database', () => {
  const opencode = localHarnessForCommand('opencode')!;
  const dbOf = (home: string): string => join(home, '.local', 'share', 'opencode', 'opencode.db');

  async function setup() {
    const { a, b, env } = await homes('opencode');
    const source = await database(dbOf(a), OPENCODE_SCHEMA);
    const target = await database(dbOf(b), OPENCODE_SCHEMA);
    const carried = insertOpenCodeSession(source, 'PELICAN-73', 1_791_000_000_000);
    const other = insertOpenCodeSession(source, 'HERON-12', 1_791_000_100_000);
    const own = insertOpenCodeSession(target, 'OSPREY-5', 1_791_000_200_000);
    return { a, b, env, source, target, carried, other, own };
  }

  it('carries the whole session and nothing else', async () => {
    const { a, b, env, source, target, carried, other, own } = await setup();
    const sourceBefore = snapshot(source);
    const ownBefore = sessionRows(target, own);

    await expect(carryNativeSession({ harness: opencode, nativeId: carried, workspace: WORKSPACE, from: env(a), to: env(b) }))
      .resolves.toBe('carried');

    expect(sessionRows(target, carried)).toBe(sessionRows(source, carried));
    expect(rows(target, 'SELECT COUNT(*) AS n FROM part WHERE session_id = ?', carried)[0]!.n).toBeGreaterThan(3);
    expect(sessionRows(target, own)).toBe(ownBefore);
    expect(rows(target, 'SELECT id FROM session WHERE id = ?', other)).toEqual([]);
    expect(snapshot(source)).toBe(sourceBefore);
  });

  it('declines a session the source does not have, writing nothing', async () => {
    const { a, b, env, target } = await setup();
    const before = snapshot(target);
    await expect(carryNativeSession({ harness: opencode, nativeId: 'ses_absent', workspace: WORKSPACE, from: env(a), to: env(b) }))
      .resolves.toBeUndefined();
    expect(snapshot(target)).toBe(before);
  });

  it('A -> B -> A ends with the newest, and a newer copy is never replaced by an older one', async () => {
    const { a, b, env, source, target, carried } = await setup();
    const store = NATIVE_SESSION_STORES.opencode!;
    await expect(store.carry!(carryInput(env, a, b, carried))).resolves.toBe(true);
    // B takes a turn: one more message and part.
    const db = open(target);
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('msg_zzzzzzzzzzzz_more', carried, 9, 9, '{"role":"user"}');
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_zzzzzzzzzzzz_more', 'msg_zzzzzzzzzzzz_more', carried, 9, 9, '{"type":"text","text":"and more"}');
    db.close();

    // Back to A, which still holds the older copy.
    await expect(store.carry!(carryInput(env, b, a, carried))).resolves.toBe(true);
    expect(sessionRows(source, carried)).toBe(sessionRows(target, carried));
    expect(rows(source, 'SELECT id FROM part WHERE id = ?', 'prt_zzzzzzzzzzzz_more')).toHaveLength(1);

    // A carry of an OLDER copy (a prefix) leaves the newer one where it is.
    const db2 = open(source);
    db2.prepare('DELETE FROM part WHERE id = ?').run('prt_zzzzzzzzzzzz_more');
    db2.close();
    const newer = snapshot(target);
    await expect(store.carry!(carryInput(env, a, b, carried))).resolves.toBe(true);
    expect(snapshot(target)).toBe(newer);
  });

  it('kilo carries through the same rows', async () => {
    const { a, b, env } = await homes('kilo');
    const kiloDb = (home: string): string => join(home, '.local', 'share', 'kilo', 'kilo.db');
    const source = await database(kiloDb(a), OPENCODE_SCHEMA);
    const target = await database(kiloDb(b), OPENCODE_SCHEMA);
    const carried = insertOpenCodeSession(source, 'KITE-9', 1_791_000_000_000);
    await expect(NATIVE_SESSION_STORES.kilo!.carry!(carryInput(env, a, b, carried))).resolves.toBe(true);
    expect(sessionRows(target, carried)).toBe(sessionRows(source, carried));
  });
});

// ---------------------------------------------------------------- Goose ----

const GOOSE_SCHEMA = [
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    user_set_name BOOLEAN DEFAULT FALSE, session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, extension_data TEXT DEFAULT '{}',
    total_tokens INTEGER, provider_name TEXT, model_config_json TEXT, goose_mode TEXT NOT NULL DEFAULT 'auto', archived_at TIMESTAMP,
    project_id TEXT, parent_session_id TEXT)`,
  `CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    tokens INTEGER, metadata_json TEXT)`,
  `CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_timestamp INTEGER NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost REAL, cost_source TEXT, is_compaction INTEGER DEFAULT 0)`,
];

/** Goose's import is its own CLI, so these rows are written as it stores a
 *  session: one row, then a message row per turn part. */
function insertGooseSession(file: string, id: string, created: string, texts: readonly string[]): void {
  const db = open(file);
  try {
    db.prepare('INSERT INTO sessions (id, name, working_dir, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, texts[0]!, WORKSPACE, created, created);
    texts.forEach((text, index) => db.prepare('INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp) VALUES (?,?,?,?,?)')
      .run(`m-${id}-${index}`, id, index % 2 ? 'assistant' : 'user', JSON.stringify([{ type: 'text', text }]), 1_791_000_000 + index));
    db.prepare('INSERT INTO usage_ledger (session_id, created_timestamp, model, total_tokens) VALUES (?,?,?,?)').run(id, 1_791_000_000, 'm', 42);
  } finally {
    db.close();
  }
}

const gooseRows = (file: string, id: string): string => JSON.stringify([
  rows(file, 'SELECT * FROM sessions WHERE id = ?', id),
  rows(file, 'SELECT message_id, role, content_json, created_timestamp FROM messages WHERE session_id = ? ORDER BY id', id),
  rows(file, 'SELECT model, total_tokens FROM usage_ledger WHERE session_id = ? ORDER BY id', id),
]);

describe.skipIf(!sqlite)('goose carries one session out of a shared database', () => {
  const dbOf = (home: string): string => join(home, '.local', 'share', 'goose', 'sessions', 'sessions.db');

  async function setup() {
    const { a, b, env } = await homes('goose');
    const source = await database(dbOf(a), GOOSE_SCHEMA);
    const target = await database(dbOf(b), GOOSE_SCHEMA);
    insertGooseSession(source, '20261005_1', '2026-10-05 10:00:00', ['remember PELICAN-73', 'noted']);
    insertGooseSession(source, '20261005_2', '2026-10-05 11:00:00', ['something else', 'ok']);
    insertGooseSession(target, '20261004_1', '2026-10-04 09:00:00', ['the other account', 'its own work']);
    return { a, b, env, source, target };
  }

  it('carries the whole session and nothing else', async () => {
    const { a, b, env, source, target } = await setup();
    const sourceBefore = snapshot(source);
    const ownBefore = gooseRows(target, '20261004_1');
    await expect(NATIVE_SESSION_STORES.goose!.carry!(carryInput(env, a, b, '20261005_1'))).resolves.toBe(true);
    expect(gooseRows(target, '20261005_1')).toBe(gooseRows(source, '20261005_1'));
    expect(gooseRows(target, '20261004_1')).toBe(ownBefore);
    expect(rows(target, "SELECT id FROM sessions WHERE id = '20261005_2'")).toEqual([]);
    expect(snapshot(source)).toBe(sourceBefore);
  });

  it('declines a missing session, and never overwrites a different conversation that reused the id', async () => {
    const { a, b, env, target } = await setup();
    // Goose numbers sessions per database: B's own 20261005_1 is not A's.
    insertGooseSession(target, '20261005_1', '2026-10-05 08:30:00', ['remember', 'B has its own']);
    const before = snapshot(target);
    await expect(NATIVE_SESSION_STORES.goose!.carry!(carryInput(env, a, b, '20261009_7'))).resolves.toBe(false);
    await expect(NATIVE_SESSION_STORES.goose!.carry!(carryInput(env, a, b, '20261005_1'))).resolves.toBe(false);
    expect(snapshot(target)).toBe(before);
  });

  it('A -> B -> A ends with the newest', async () => {
    const { a, b, env, source, target } = await setup();
    const store = NATIVE_SESSION_STORES.goose!;
    await expect(store.carry!(carryInput(env, a, b, '20261005_1'))).resolves.toBe(true);
    const db = open(target);
    db.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?,?,?,?)').run('20261005_1', 'user', '[{"type":"text","text":"more"}]', 1_791_000_009);
    db.close();
    await expect(store.carry!(carryInput(env, b, a, '20261005_1'))).resolves.toBe(true);
    expect(gooseRows(source, '20261005_1')).toBe(gooseRows(target, '20261005_1'));
    expect(rows(source, "SELECT COUNT(*) AS n FROM messages WHERE session_id = '20261005_1'")[0]!.n).toBe(3);
  });
});

// ---------------------------------------------------------------- Devin ----

const DEVIN_SCHEMA = [
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL,
    agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
    shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT)`,
  `CREATE TABLE prompt_history (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, timestamp INTEGER NOT NULL,
    session_id TEXT NOT NULL, is_shell INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
    parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id), UNIQUE(session_id, node_id))`,
  `CREATE TABLE tool_call_state (session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, tool_call_json TEXT, tool_call_update_json TEXT,
    PRIMARY KEY (session_id, tool_call_id), FOREIGN KEY (session_id) REFERENCES sessions(id))`,
];

function writeContext(command: string, environment: Record<string, string>, version: string): NativeThreadWriteContext {
  return { harness: localHarnessForCommand(command)!, workspace: WORKSPACE, environment, model: 'm', version };
}

describe.skipIf(!sqlite)('devin carries one session out of a shared database', () => {
  const dbOf = (home: string): string => join(home, '.local', 'share', 'devin', 'cli', 'sessions.db');
  const store = NATIVE_SESSION_STORES.devin!;
  const devinRows = (file: string, id: string): string => JSON.stringify([
    rows(file, 'SELECT * FROM sessions WHERE id = ?', id),
    rows(file, 'SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ? ORDER BY node_id', id),
    rows(file, 'SELECT * FROM tool_call_state WHERE session_id = ?', id),
    rows(file, 'SELECT content FROM prompt_history WHERE session_id = ? ORDER BY id', id),
  ]);

  async function setup() {
    const { a, b, env } = await homes('devin');
    const source = await database(dbOf(a), DEVIN_SCHEMA);
    const target = await database(dbOf(b), DEVIN_SCHEMA);
    const write = (home: string, codeword: string) => store.writer!.write(record(codeword), writeContext('devin', env(home), '3000.11.3'))
      .then((written) => written!.nativeId);
    const carried = await write(a, 'PELICAN-73');
    const other = await write(a, 'HERON-12');
    const own = await write(b, 'OSPREY-5');
    const db = open(source);
    db.prepare('INSERT INTO tool_call_state VALUES (?,?,?,?)').run(carried, 'call_1', '{}', '{}');
    db.prepare('INSERT INTO prompt_history (content, timestamp, session_id) VALUES (?,?,?)').run('Remember the codeword PELICAN-73.', 1, carried);
    db.close();
    return { a, b, env, source, target, carried, other, own };
  }

  it('carries the whole session and nothing else', async () => {
    const { a, b, env, source, target, carried, other, own } = await setup();
    const sourceBefore = snapshot(source);
    const ownBefore = devinRows(target, own);
    await expect(store.carry!(carryInput(env, a, b, carried))).resolves.toBe(true);
    expect(devinRows(target, carried)).toBe(devinRows(source, carried));
    expect(devinRows(target, carried)).toContain('PELICAN-73');
    expect(devinRows(target, own)).toBe(ownBefore);
    expect(rows(target, 'SELECT id FROM sessions WHERE id = ?', other)).toEqual([]);
    expect(snapshot(source)).toBe(sourceBefore);
  });

  it('declines a missing session, writing nothing', async () => {
    const { a, b, env, target } = await setup();
    const before = snapshot(target);
    await expect(store.carry!(carryInput(env, a, b, 'clikcode-absent'))).resolves.toBe(false);
    expect(snapshot(target)).toBe(before);
  });

  it('A -> B -> A ends with the newest', async () => {
    const { a, b, env, source, target, carried } = await setup();
    await expect(store.carry!(carryInput(env, a, b, carried))).resolves.toBe(true);
    const db = open(target);
    const last = (db.prepare('SELECT MAX(node_id) AS n FROM message_nodes WHERE session_id = ?').get(carried) as { n: number }).n;
    db.prepare('INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?,?,?,?,?)')
      .run(carried, last + 1, last, '{"role":"user","content":"more"}', 2);
    db.prepare('UPDATE sessions SET main_chain_id = ? WHERE id = ?').run(last + 1, carried);
    db.close();
    await expect(store.carry!(carryInput(env, b, a, carried))).resolves.toBe(true);
    expect(devinRows(source, carried)).toBe(devinRows(target, carried));
  });
});

// --------------------------------------------------------- MiniMax Code ----

const MCODE_SCHEMA = [
  `CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
    columnar_version INTEGER NOT NULL DEFAULT 0, agent_name TEXT, runtime TEXT, session_type TEXT, status TEXT,
    archived INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'visible', session_kind TEXT NOT NULL DEFAULT 'unknown',
    purpose TEXT, purpose_kind TEXT NOT NULL DEFAULT '', origin_cron_id TEXT, parent_session_id TEXT, workspace_dir TEXT,
    project_workspace_dir TEXT, is_default_workspace INTEGER NOT NULL DEFAULT 0, title TEXT, created_at_ms INTEGER,
    error_message TEXT, error_code INTEGER, extra_data_json TEXT NOT NULL DEFAULT '{}', project_id INTEGER, history_relative_dir TEXT)`,
  `CREATE TABLE local_runtime_pi_history_file_migrations (session_id TEXT PRIMARY KEY, migrated_at_ms INTEGER NOT NULL,
    source TEXT NOT NULL, message_count INTEGER NOT NULL, target_revision TEXT NOT NULL)`,
];

/** Every file under `directory`, by relative path, with its content. */
async function tree(directory: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else out[relative(directory, child)] = await readFile(child, 'utf8');
    }
  };
  await walk(directory).catch(() => undefined);
  return out;
}

describe.skipIf(!sqlite)('mcode carries one session: its row, its checkpoint and its history directory', () => {
  const store = NATIVE_SESSION_STORES.mcode!;
  const dbOf = (home: string): string => join(home, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
  const sessionsOf = (home: string): string => join(home, '.minimax', 'v2', 'sessions');
  const mcodeRows = (file: string, id: string): string => JSON.stringify([
    rows(file, 'SELECT * FROM local_runtime_sessions WHERE session_id = ?', id),
    rows(file, 'SELECT * FROM local_runtime_pi_history_file_migrations WHERE session_id = ?', id),
  ]);
  const historyOf = (file: string, id: string): string =>
    String(rows(file, 'SELECT history_relative_dir AS d FROM local_runtime_sessions WHERE session_id = ?', id)[0]!.d);

  async function setup() {
    const { a, b, env } = await homes('mcode');
    const source = await database(dbOf(a), MCODE_SCHEMA);
    const target = await database(dbOf(b), MCODE_SCHEMA);
    const write = (home: string, codeword: string) => store.writer!.write(record(codeword), writeContext('mcode', env(home), '0.5.10'))
      .then((written) => written!.nativeId);
    const carried = await write(a, 'PELICAN-73');
    const other = await write(a, 'HERON-12');
    const own = await write(b, 'OSPREY-5');
    return { a, b, env, source, target, carried, other, own };
  }

  it('carries the whole session and nothing else', async () => {
    const { a, b, env, source, target, carried, other, own } = await setup();
    const sourceBefore = [snapshot(source), JSON.stringify(await tree(sessionsOf(a)))];
    const ownBefore = [mcodeRows(target, own), JSON.stringify(await tree(join(sessionsOf(b), historyOf(target, own))))];

    await expect(store.carry!(carryInput(env, a, b, carried))).resolves.toBe(true);

    expect(mcodeRows(target, carried)).toBe(mcodeRows(source, carried));
    const relativeDir = historyOf(source, carried);
    const files = await tree(join(sessionsOf(b), relativeDir));
    expect(files).toEqual(await tree(join(sessionsOf(a), relativeDir)));
    expect(files['messages.jsonl']).toContain('PELICAN-73');
    expect([mcodeRows(target, own), JSON.stringify(await tree(join(sessionsOf(b), historyOf(target, own))))]).toEqual(ownBefore);
    expect(rows(target, 'SELECT session_id FROM local_runtime_sessions WHERE session_id = ?', other)).toEqual([]);
    // Nothing staged or displaced is left beside it.
    expect((await readdir(join(sessionsOf(b), relativeDir, '..'))).filter((name) => /\.(carry|old)$/.test(name))).toEqual([]);
    expect([snapshot(source), JSON.stringify(await tree(sessionsOf(a)))]).toEqual(sourceBefore);
  });

  it('declines a missing session, writing nothing', async () => {
    const { a, b, env, target } = await setup();
    const before = [snapshot(target), JSON.stringify(await tree(sessionsOf(b)))];
    await expect(store.carry!(carryInput(env, a, b, 'mvs_absent'))).resolves.toBe(false);
    expect([snapshot(target), JSON.stringify(await tree(sessionsOf(b)))]).toEqual(before);
  });

  it('A -> B -> A ends with the newest transcript', async () => {
    const { a, b, env, carried, source } = await setup();
    await expect(store.carry!(carryInput(env, a, b, carried))).resolves.toBe(true);
    const relativeDir = historyOf(source, carried);
    await appendFile(join(sessionsOf(b), relativeDir, 'messages.jsonl'), '{"message_id":"more","turn_id":"t","message":{"role":"user"}}\n');
    await expect(store.carry!(carryInput(env, b, a, carried))).resolves.toBe(true);
    expect(await tree(join(sessionsOf(a), relativeDir))).toEqual(await tree(join(sessionsOf(b), relativeDir)));
    expect(await readFile(join(sessionsOf(a), relativeDir, 'messages.jsonl'), 'utf8')).toContain('"message_id":"more"');
  });
});

// --------------------------------------------------------------- Cursor ----

describe('cursor: a session is its own directory, carried only once verified', () => {
  it('locates a session directory the writer laid out, and nothing else', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-cursor-carry-'));
    const root = cursorAcpSessionsRoot({ HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
    await mkdir(root, { recursive: true });
    const agentId = '0d4b32b7-edaf-405f-adca-4a9ad577b6a3';
    const path = await writeCursorStore(root, cursorStore(record('PELICAN-73'), { agentId, workspace: WORKSPACE, startMs: 1 }));
    expect((await stat(join(path, 'store.db'))).isFile()).toBe(true);
    await expect(locateCursorSession(root, agentId)).resolves.toEqual({ path, root });
    await expect(locateCursorSession(root, 'never-existed')).resolves.toBeUndefined();
    await expect(locateCursorSession(root, '../escape')).resolves.toBeUndefined();
  });

  it('stays off until a model turn proves it: a failover re-seeds', async () => {
    expect(CURSOR_CARRY_VERIFIED).toBe(false);
    expect(NATIVE_SESSION_STORES.cursor!.locate).toBeUndefined();
    expect(NATIVE_SESSION_STORES.cursor!.carry).toBeUndefined();
  });
});

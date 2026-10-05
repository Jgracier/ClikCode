/** Goose keeps every conversation as rows in one SQLite database,
 * `<XDG_DATA_HOME or ~/.local/share>/goose/sessions/sessions.db` (observed on
 * 1.51.0), shared by its CLI and its ACP agent.
 *
 * No `locate`: the database also holds the account's other sessions, so it
 * is not a per-conversation path. A failover `carry`s the session's rows
 * instead (gooseCarry). The writer: Goose imports a Claude Code transcript
 * (`goose session import <file>`), printing `Session imported:` and then
 * `<id> - <name>`, and `goose run --resume --name <id>` -- the catalog's
 * resume argv -- continues that session by id (verified: no new session, the
 * imported one grew). */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NativeSessionEnvironment, NativeSessionStore } from '../stores.js';
import { claudeImportWriter } from './claude-import.js';
import { carrySqliteSession, progressQuery, type SqliteCarrySpec } from './sqlite-carry.js';
import { jsonPartText, sqliteOpenings } from './sqlite-openings.js';

function gooseRoot(environment: NativeSessionEnvironment): string {
  const data = environment.XDG_DATA_HOME?.trim() || join(environment.HOME?.trim() || homedir(), '.local', 'share');
  return join(data, 'goose', 'sessions');
}

/** One conversation in Goose 1.51.0's sessions.db (schema read from one it
 *  made in vendor-sandbox): the `sessions` row, its `messages` and its
 *  `usage_ledger`, both AUTOINCREMENT-keyed, so the destination numbers them.
 *
 *  Goose names a session by date and a per-database counter (`20261005_1`),
 *  so the same id in another profile is often ANOTHER conversation: a
 *  same-id row there is replaced only when it was created at the same moment
 *  and holds a prefix of this one's messages.
 *
 *  Verified against goose 1.51.0 (2026-10-05, vendor-sandbox, provider
 *  codex/gpt-5.5, ACP as ClikCode drives it): session 20261005_2 made in
 *  profile A ("Remember the word TUNDRA69") was carried into a profile B
 *  holding its own 20261005_1 ('carried'; A and B's own session unchanged),
 *  and the ACP resume of that id in B answered TUNDRA69. After a second turn
 *  in B ("remember the number 332") it was carried back, and A's resume
 *  answered "TUNDRA69 332".
 *
 *  Seen in the same run: two profiles that each start a session the same day
 *  both name it 20261005_1, and that carry is declined (created_at differs),
 *  both databases untouched -- the failover then re-seeds. (Goose's codex
 *  provider also fails every turn under GOOSE_MODE=approve, ClikCode's `ask`:
 *  "Codex command failed with exit code: Some(1)"; the run used bypass.) */
export const gooseCarry: SqliteCarrySpec = {
  database: (environment) => join(gooseRoot(environment), 'sessions.db'),
  session: { table: 'sessions', key: 'id', identity: ['created_at'], parent: 'parent_session_id' },
  rows: [
    { table: 'messages', key: 'session_id', omit: ['id'], order: 'id' },
    { table: 'usage_ledger', key: 'session_id', omit: ['id'], order: 'id' },
  ],
  required: {
    sessions: ['id', 'working_dir', 'created_at'],
    messages: ['id', 'session_id', 'role', 'content_json', 'created_timestamp'],
  },
  progress: progressQuery(
    "SELECT role || char(31) || created_timestamp || char(31) || content_json AS k FROM {db}.messages WHERE session_id = ? ORDER BY id",
  ),
};

export const gooseSessionStore: NativeSessionStore = {
  root: gooseRoot,
  carry: (input) => carrySqliteSession(gooseCarry, input),
  // `messages.content_json` is the message's parts (observed on 1.51.0).
  openings: (root, nativeIds) => sqliteOpenings(join(root, 'sessions.db'), nativeIds,
    "SELECT content_json AS text FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 1", jsonPartText),
  // Pinned to the CLI: the resume verified above is the CLI's.
  writer: claudeImportWriter({
    testedVersions: ['1.51.0'], transport: 'structured-cli',
    argv: (file) => ['session', 'import', file],
    parse: (output) => /Session imported:\s*\n\s*(\S+) - /.exec(output)?.[1],
  }),
};

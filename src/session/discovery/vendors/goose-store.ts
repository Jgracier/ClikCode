/** Goose keeps every conversation as rows in one SQLite database,
 * `<XDG_DATA_HOME or ~/.local/share>/goose/sessions/sessions.db` (observed on
 * 1.51.0), shared by its CLI and its ACP agent.
 *
 * No `locate` and no `carry`: the database also holds the account's other
 * sessions, so it is not a per-conversation path, and nobody has verified
 * moving rows between two of them. What this store adds is the writer: Goose
 * imports a Claude Code transcript (`goose session import <file>`), printing
 * `Session imported:` and then `<id> - <name>`, and `goose run --resume
 * --name <id>` -- the catalog's resume argv -- continues that session by id
 * (verified: no new session, the imported one grew). */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NativeSessionEnvironment, NativeSessionStore } from '../stores.js';
import { claudeImportWriter } from './claude-import.js';
import { jsonPartText, sqliteOpenings } from './sqlite-openings.js';

export const gooseSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    const data = environment.XDG_DATA_HOME?.trim() || join(environment.HOME?.trim() || homedir(), '.local', 'share');
    return join(data, 'goose', 'sessions');
  },
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

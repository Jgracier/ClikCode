/** Antigravity keeps one SQLite file per conversation, flat.
 *
 * `<HOME>/.gemini/antigravity-cli/conversations/<conversation_id>.db`, where
 * the id is exactly the `conversation_id` its stream reports and the one
 * ClikCode already stores as nativeSessionId. Directly observed: 52 such files
 * across this machine's profiles, one of which matched a live session's id.
 *
 * Flat, not project-scoped, so the workspace plays no part in finding it --
 * unlike Claude Code, which buries the file under a directory named after the
 * cwd.
 *
 * Safe to copy as a single file: they are plain SQLite with no -wal or -shm
 * sidecars alongside them, checked across every profile. A journal left beside
 * the database would make a lone copy a torn one.
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore } from '../stores.js';

export const antigravitySessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    return join(nativeDataRoot(environment, 'HOME', homedir()), '.gemini', 'antigravity-cli', 'conversations');
  },
  async locate(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
    const path = join(root, `${nativeId}.db`);
    return await stat(path).then(() => ({ path, root }), () => undefined);
  },
};

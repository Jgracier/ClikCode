/** Everything ClikCode keeps about one conversation outside its transcript,
 * and removing all of it when the conversation is deleted.
 *
 * Deleting a chat used to remove its row and transcript only. The agent
 * loop's own history (sessions/<id>/harness.jsonl), its file checkpoints for
 * /undo (checkpoints/<id>), the turn-change log (turn-changes/<id>.json) and
 * the claim stayed behind: 176 of 178 harness histories and 135 of 136
 * checkpoint directories on one machine belonged to chats long gone. */

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { safeRecordFileName, sessionsDirectory, stateDirectory } from './paths.js';

/** The names each store gives a session id -- the same rules those stores
 * use (agent/conversation.ts, agent/file-checkpoints.ts, session/turn-changes.ts,
 * session/claims.ts), restated so this file reaches every one without
 * depending on any. */
function artifactPaths(id: string): string[] {
  const root = stateDirectory();
  const record = safeRecordFileName(id);
  const segment = id.replace(/[^A-Za-z0-9._-]/g, '_');
  const paths = [
    join(root, 'turn-changes', `${record}.json`),
    join(root, 'turn-changes', `${record}.json.lock`),
    join(root, 'claims', `${record}.json`),
    join(sessionsDirectory(), `${record}.lock`),
    join(sessionsDirectory(), `${record}.resume-in.lock`),
  ];
  if (segment && segment !== '.' && segment !== '..') paths.push(join(root, 'checkpoints', segment));
  if (/^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== '.' && id !== '..') paths.push(join(sessionsDirectory(), id));
  return paths;
}

/** Removes every per-session artifact of a deleted conversation. Its
 * transcript and index row are the state writer's (writeState), and go first. */
export async function forgetSessionArtifacts(id: string): Promise<void> {
  await Promise.all(artifactPaths(id).map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
}

/** Session ids that have artifacts on disk, for a sweep of ones whose chat is
 * gone. Only names a store could have produced from an id are returned. */
export async function sessionIdsWithArtifacts(): Promise<Set<string>> {
  const root = stateDirectory();
  const ids = new Set<string>();
  const names = async (directory: string) => readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of await names(sessionsDirectory())) if (entry.isDirectory()) ids.add(entry.name);
  for (const entry of await names(join(root, 'checkpoints'))) if (entry.isDirectory()) ids.add(entry.name);
  for (const entry of await names(join(root, 'turn-changes'))) if (entry.isFile() && entry.name.endsWith('.json')) ids.add(entry.name.slice(0, -'.json'.length));
  return ids;
}

/** Leftovers a crashed process could not clean up: atomic-write temporaries
 * (`*.tmp`) and claim staging files (`*.new`) nothing has touched for
 * `olderThanMs` -- live ones are milliseconds old -- and the per-session
 * `sessions/<id>.lock` files of builds before the single state lock, which
 * nothing creates any more. Locks still in use are never touched here: one
 * could be re-created between the look and the removal. Returns how many went. */
export async function removeStrandedFiles(olderThanMs: number, now = Date.now()): Promise<number> {
  const root = stateDirectory();
  let removed = 0;
  for (const directory of [root, sessionsDirectory(), join(root, 'claims'), join(root, 'turn-changes'), join(root, 'cache')]) {
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      const legacyLock = directory === sessionsDirectory() && /^[^.]+\.lock$/.test(name);
      if (!/\.(tmp|new)$/.test(name) && !legacyLock) continue;
      const path = join(directory, name);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile() || now - info.mtimeMs < olderThanMs) continue;
      await rm(path, { force: true }).then(() => { removed += 1; }, () => undefined);
    }
  }
  return removed;
}

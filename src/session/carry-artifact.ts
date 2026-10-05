/** Placing one copied conversation artifact -- a transcript file, or a
 * directory of them -- at its destination in another account's profile.
 *
 * Shared by session/carry.ts (every `locate` store) and the stores that carry
 * a conversation themselves but still keep part of it as one path (Kiro's
 * one-shot CLI sessions), so "which copy wins" and "never leave a half copy"
 * are decided in one place. */

import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Copies `source` to `destination`, returning whether the destination now
 * holds the current conversation; false when there is no source.
 *
 * A conversation that went A -> B -> A finds its own earlier copy waiting in
 * A, one switch out of date: everything the thread said while B owned it is
 * only in B's copy. Keeping that copy would resume the older transcript and
 * silently drop that work. A vendor transcript is an append-only log, so the
 * newer, longer artifact is the current one, and it replaces what is there; an
 * identical one is left alone.
 *
 * Throws when the copy itself fails; nothing is left half-written. */
export async function placeArtifact(source: string, destination: string): Promise<boolean> {
  const [here, there] = await Promise.all([measure(destination), measure(source)]);
  if (!there) return false;
  if (here && here.size >= there.size && here.mtime >= there.mtime) return true;
  await mkdir(dirname(destination), { recursive: true });
  // Through a temporary name in the destination directory: a half-copied
  // transcript that a resume then read would be worse than no transcript.
  const staged = `${destination}.clikcode-carry`;
  await rm(staged, { recursive: true, force: true });
  await cp(source, staged, { recursive: true });
  // rename() replaces an existing destination atomically -- but only a file
  // over a file. A non-empty directory refuses to be renamed over, so the one
  // already there moves aside first and is deleted only once the new one is in
  // place; a crash in between leaves the old copy recoverable rather than
  // leaving no copy at all.
  if (here?.directory) {
    const displaced = `${destination}.clikcode-old`;
    await rm(displaced, { recursive: true, force: true });
    await rename(destination, displaced);
    await rename(staged, destination);
    await rm(displaced, { recursive: true, force: true });
  } else {
    await rename(staged, destination);
  }
  return true;
}

/** Size and recency of an artifact, whether it is one transcript or a tree of
 *  them, so the "newer and longer wins" rule above reads the same for both.
 *
 *  A vendor transcript is append-only, so total bytes across the tree only
 *  grows as a conversation does, and the newest mtime in it is when the thread
 *  last spoke. Comparing the aggregate is therefore the same comparison a
 *  single file gets, not an approximation of it. */
async function measure(
  path: string,
): Promise<{ size: number; mtime: number; directory: boolean } | undefined> {
  const entry = await stat(path).catch(() => undefined);
  if (!entry) return undefined;
  if (!entry.isDirectory()) return { size: entry.size, mtime: entry.mtimeMs, directory: false };
  let size = 0;
  let mtime = entry.mtimeMs;
  for (const child of await readdir(path, { withFileTypes: true })) {
    const inner = await measure(join(path, child.name));
    if (!inner) continue;
    size += inner.size;
    mtime = Math.max(mtime, inner.mtime);
  }
  return { size, mtime, directory: true };
}

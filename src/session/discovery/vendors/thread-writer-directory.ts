/** A thread that is a DIRECTORY of files (Grok, Cline, Kimi) written as one
 * unit: every file goes into a temporary sibling directory, which is renamed
 * into place only once all of them are there -- so a vendor scanning for
 * sessions never finds half of one, and a failure leaves nothing behind. */

import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Writes `files` (paths relative to `directory`) and renames the whole
 *  directory into place. Refuses to replace one that exists: a writer makes
 *  a NEW thread, never touches an existing one. */
export async function writeDirectoryAtomic(directory: string, files: Readonly<Record<string, string>>): Promise<void> {
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const staging = `${directory}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    for (const [relative, content] of Object.entries(files)) {
      const path = join(staging, relative);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    // rename() over an existing non-empty directory fails (ENOTEMPTY), and an
    // empty one is not a thread anyone owns -- so this never clobbers one.
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Writing a file so that a crash cannot leave a half-written one, into a
 * directory only this user can read. */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const hardenedDirectories = new Set<string>();

/** Creates the directory 0700 and also repairs the mode of one that already
 * existed: `mkdir`'s mode is ignored for an existing directory, which is how a
 * state directory created by an older build or by hand stayed world-readable. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (hardenedDirectories.has(directory)) return;
  await chmod(directory, 0o700).catch(() => undefined);
  hardenedDirectories.add(directory);
}

/** Temp file, fsync, rename. Without the fsync a power loss shortly after the
 * rename can leave a zero-length file under the final name on some filesystems. */
export async function atomicWriteFile(path: string, data: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

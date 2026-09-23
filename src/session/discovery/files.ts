/** The filesystem reads discovery is built on, all bounded: a file's head or
 * tail, a capped recursive walk, and the newest entries of a directory. */

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function readFilePrefix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The last `maxBytes` of a file, from the first newline inside that window so
 * the caller never sees half a record. Bounded work whatever the file's size,
 * which matters here: these transcripts reach tens of megabytes. */
export async function readFileSuffix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(maxBytes, size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, size - length));
    const text = buffer.toString('utf8', 0, bytesRead);
    if (length >= size) return text;
    const newline = text.indexOf('\n');
    return newline === -1 ? '' : text.slice(newline + 1);
  } finally {
    await handle.close();
  }
}

export async function walkFilesRecursive(dir: string, maxDepth: number, suffix: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch {
    // fail-open-ok: a missing or unreadable optional vendor history directory has no sessions.
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && maxDepth > 0) files.push(...await walkFilesRecursive(full, maxDepth - 1, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(full);
  }
  return files;
}

export async function newestFiles(paths: readonly string[], limit: number): Promise<Array<{ path: string; mtimeMs: number }>> {
  const stats = await Promise.all(paths.map(async (path) => {
    const info = await stat(path).catch(() => undefined);
    return info ? { path, mtimeMs: info.mtimeMs } : undefined;
  }));
  return stats.filter((item): item is { path: string; mtimeMs: number } => Boolean(item))
    .sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Persistent discovery cache
// ---------------------------------------------------------------------------

export async function sortedSubdirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch {
    // fail-open-ok: a missing or unreadable optional vendor history directory has no sessions.
    return [];
  }
}

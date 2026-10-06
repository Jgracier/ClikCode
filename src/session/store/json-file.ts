/** A small JSON file that every ClikCode process on the machine reads,
 * changes and writes back (a record of decisions, not a cache). The read and
 * the write happen under one lock on `<path>.lock`, so two workers changing
 * it at once never drop each other's change, and the write is atomic, so a
 * reader never sees half of one. */

import { readFile } from 'node:fs/promises';
import { atomicWriteFile } from './files.js';
import { withFileLock } from './locks.js';

/** `parse` turns the file's text (undefined: no file) into the value;
 * `change` returns the value to write, or undefined to leave the file as it
 * is. Returns what the file holds afterwards. */
export async function updateJsonFile<T>(
  path: string,
  parse: (raw: string | undefined) => T,
  change: (current: T) => T | undefined,
): Promise<T> {
  return withFileLock(`${path}.lock`, async () => {
    const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const current = parse(raw);
    const next = change(current);
    if (next === undefined) return current;
    await atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

/** The parse for a file that is one JSON object: anything else reads as empty. */
export function objectOrEmpty(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    // fail-open-ok: every writer is atomic, so this is external damage; the caller's record starts over.
    return {};
  }
}

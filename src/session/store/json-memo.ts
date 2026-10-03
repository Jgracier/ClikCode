/** A JSON file under ClikCode's state directory that remembers derived facts
 * across runs -- harness versions, model catalogs, session discovery. Each
 * entry is validated by the caller against the identity of what it was
 * derived from (a file's path, mtime and size; a binary's build), so a
 * missing, damaged or foreign-format file only ever reads as empty: one
 * round of recomputation, never an error. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from './files.js';
import { stateDirectory } from './paths.js';

export interface JsonMemo<T> {
  /** The contents, read once per state directory and then held in memory. */
  load(): Promise<T>;
  /** The file as it is on disk right now, bypassing the held copy. */
  read(): Promise<T | undefined>;
  /** Marks the held contents as needing a write. */
  changed(): void;
  readonly dirty: boolean;
  /** Writes the held contents if they changed since the last write. */
  save(): Promise<void>;
  /** Replaces the contents and writes them now. */
  write(data: T): Promise<void>;
  /** Forgets the held contents; the next load reads the file again. */
  reset(): void;
}

/** `relativePath` is under the state directory. `accept` returns the parsed
 * file when it has the expected shape, undefined otherwise. */
export function jsonMemo<T>(relativePath: string, empty: () => T, accept: (parsed: unknown) => T | undefined): JsonMemo<T> {
  let held: { path: string; data: T; dirty: boolean } | undefined;
  const memoPath = (): string | undefined => {
    // Tests that never relocated ClikCode's state must not touch the real one.
    if (process.env.VITEST && !process.env.CLIKCODE_HOME?.trim()) return undefined;
    const directory = stateDirectory();
    return directory ? join(directory, relativePath) : undefined;
  };
  const readAt = async (path: string | undefined): Promise<T | undefined> => {
    if (!path) return undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      return parsed && typeof parsed === 'object' ? accept(parsed) : undefined;
    } catch { return undefined; /* fail-open-ok: a missing or damaged memo costs one recomputation. */ }
  };
  const save = async (): Promise<void> => {
    const path = memoPath();
    if (!path || !held?.dirty || held.path !== path) return;
    held.dirty = false;
    await atomicWriteFile(path, JSON.stringify(held.data)).catch(() => undefined);
  };
  return {
    async load() {
      const path = memoPath();
      if (held && held.path === (path ?? '')) return held.data;
      const data = (await readAt(path)) ?? empty();
      held = { path: path ?? '', data, dirty: false };
      return data;
    },
    read: () => readAt(memoPath()),
    changed() { if (held) held.dirty = true; },
    get dirty() { return Boolean(held?.dirty); },
    save,
    async write(data) {
      held = { path: memoPath() ?? '', data, dirty: true };
      await save();
    },
    reset() { held = undefined; },
  };
}

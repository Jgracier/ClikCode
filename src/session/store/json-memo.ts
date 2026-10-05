/** A JSON file under ClikCode's state directory that remembers derived facts
 * across runs -- harness versions, model catalogs, session discovery. Each
 * entry is validated by the caller against the identity of what it was
 * derived from (a file's path, mtime and size; a binary's build), so a
 * missing, damaged or foreign-format file only ever reads as empty: one
 * round of recomputation, never an error.
 *
 * Every ClikCode process on the machine shares the file. Held once per
 * process, a long-lived window never saw what another had written since (a
 * harness version, a discovered catalog) and recomputed it, and its next
 * save wrote its older copy over the other's entries. So the held copy is
 * re-synced whenever the file's identity changes (one stat per access), and
 * a save first folds in what is on disk.
 *
 * The fold is three-way, against the file as this process last saw it: a
 * memo file is a few top-level fields, each a value or a map of entries, and
 * each entry this process changed is kept while every other one takes the
 * file's version (a deleted entry stays deleted). Entries are merged whole --
 * mixing the fields of two writers' entries could pair one's fingerprint with
 * the other's result. */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from './cached-file.js';
import { sameData } from './data.js';
import { atomicWriteFile } from './files.js';
import { stateDirectory } from './paths.js';

export interface JsonMemo<T> {
  /** The contents, kept in step with the file: re-read (and merged with this
   * process's unsaved changes) when another process has written it. The
   * returned object stays the same one; mutate it, then call changed(). */
  load(): Promise<T>;
  /** The file as it is on disk right now, bypassing the held copy. */
  read(): Promise<T | undefined>;
  /** Marks the held contents as needing a write. */
  changed(): void;
  readonly dirty: boolean;
  /** Writes the held contents, merged with the file's, if they changed. */
  save(): Promise<void>;
  /** Replaces the contents and writes them now, as they are. */
  write(data: T): Promise<void>;
  /** Forgets the held contents; the next load reads the file again. */
  reset(): void;
}

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => !!value && typeof value === 'object' && !Array.isArray(value);

/** Folds `theirs` into `ours` in place, keeping what `ours` changed since
 * `base`. `depth` 0 is the file's top-level fields, 1 the entries of a map. */
function fold(base: Fields, ours: Fields, theirs: Fields, depth: number): void {
  for (const key of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const [b, o, t] = [base[key], ours[key], theirs[key]];
    if (depth === 0 && isFields(b) && isFields(o) && isFields(t)) { fold(b, o, t, 1); continue; }
    if (!sameData(o, b)) continue; // Changed here: this process's entry wins.
    if (t === undefined) delete ours[key];
    else ours[key] = t;
  }
}

/** `relativePath` is under the state directory. `accept` returns the parsed
 * file when it has the expected shape, undefined otherwise. */
export function jsonMemo<T>(relativePath: string, empty: () => T, accept: (parsed: unknown) => T | undefined): JsonMemo<T> {
  /** `base` is the file as this process last read or wrote it, a separate
   * copy; `identity` the file's then (undefined: missing). */
  let held: { path: string; data: T; base: T; identity: string | undefined; dirty: boolean } | undefined;
  const memoPath = (): string | undefined => {
    // Tests that never relocated ClikCode's state must not touch the real one.
    if (process.env.VITEST && !process.env.CLIKCODE_HOME?.trim()) return undefined;
    const directory = stateDirectory();
    return directory ? join(directory, relativePath) : undefined;
  };
  const parse = (raw: string): T | undefined => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? accept(parsed) : undefined;
    } catch { return undefined; /* fail-open-ok: a damaged memo costs one recomputation. */ }
  };
  const readAt = async (path: string | undefined): Promise<T | undefined> => {
    if (!path) return undefined;
    const raw = await readFile(path, 'utf8').catch(() => undefined);
    return raw === undefined ? undefined : parse(raw);
  };
  const identityOf = (path: string): Promise<string | undefined> => stat(path).then(fileIdentity, () => undefined);
  /** The file now, twice parsed: one copy to merge from, one to keep as base. */
  const snapshot = async (path: string | undefined): Promise<{ theirs: T; base: T; identity: string | undefined }> => {
    const identity = path ? await identityOf(path) : undefined;
    const raw = identity && path ? await readFile(path, 'utf8').catch(() => undefined) : undefined;
    const read = () => (raw === undefined ? undefined : parse(raw)) ?? empty();
    return { theirs: read(), base: read(), identity };
  };
  /** Brings the held copy level with the file, if the file changed. */
  const sync = async (current: NonNullable<typeof held>): Promise<void> => {
    if (!current.path || await identityOf(current.path) === current.identity) return;
    const { theirs, base, identity } = await snapshot(current.path);
    if (held !== current) return; // Reset meanwhile.
    if (isFields(current.data) && isFields(current.base) && isFields(theirs)) fold(current.base, current.data, theirs, 0);
    else if (sameData(current.data, current.base)) current.data = theirs;
    current.base = base;
    current.identity = identity;
  };
  const store = async (current: NonNullable<typeof held>): Promise<void> => {
    current.dirty = false;
    const raw = JSON.stringify(current.data);
    if (!await atomicWriteFile(current.path, raw).then(() => true, () => false)) return;
    current.base = parse(raw) ?? empty();
    current.identity = await identityOf(current.path);
  };
  const load = async (): Promise<NonNullable<typeof held>> => {
    const path = memoPath() ?? '';
    if (held && held.path === path) {
      await sync(held);
      return held;
    }
    const { theirs, base, identity } = await snapshot(path || undefined);
    if (held && held.path === path) return held; // Another load got here first.
    held = { path, data: theirs, base, identity, dirty: false };
    return held;
  };
  return {
    async load() { return (await load()).data; },
    read: () => readAt(memoPath()),
    changed() { if (held) held.dirty = true; },
    get dirty() { return Boolean(held?.dirty); },
    async save() {
      if (!held?.dirty || held.path !== (memoPath() ?? '') || !held.path) return;
      const current = held;
      await sync(current);
      await store(current);
    },
    async write(data) {
      const path = memoPath() ?? '';
      held = { path, data, base: data, identity: undefined, dirty: true };
      if (path) await store(held);
    },
    reset() { held = undefined; },
  };
}

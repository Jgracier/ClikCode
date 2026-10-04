/** A file parsed once per version of it.
 *
 * Every state file is replaced by rename or grown by append, so its inode,
 * size and change time move whenever its bytes do: an unchanged file costs
 * one stat, not a read and a parse. A file replaced between the stat and the
 * read is not pinned to that identity -- it is compared by its bytes next
 * time instead. Parsed values are shared and must be treated as immutable. */

import { readFile, stat } from 'node:fs/promises';

interface Entry<T> { identity?: string; raw: string; value: T }

export function fileIdentity(info: { ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

export interface CachedFile<T> {
  /** The parsed file, or undefined when it does not exist. `parse` may throw. */
  load(): Promise<T | undefined>;
  /** Records what this process just wrote, so the next load need not read it. */
  remember(raw: string, value: T): Promise<void>;
  reset(): void;
}

export function cachedFile<T>(path: () => string, parse: (raw: string) => T): CachedFile<T> {
  let entry: (Entry<T> & { path: string }) | undefined;
  const current = (): Entry<T> | undefined => (entry && entry.path === path() ? entry : undefined);
  return {
    async load() {
      const file = path();
      let raw: string;
      let identity: string | undefined;
      try {
        identity = fileIdentity(await stat(file));
        const held = current();
        if (held && held.identity === identity) return held.value;
        raw = await readFile(file, 'utf8');
        if (fileIdentity(await stat(file)) !== identity) identity = undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      const held = current();
      if (held && held.raw === raw) {
        held.identity = identity;
        return held.value;
      }
      const value = parse(raw);
      entry = { path: file, raw, value, ...(identity ? { identity } : {}) };
      return value;
    },
    async remember(raw, value) {
      const file = path();
      const info = await stat(file).catch(() => undefined);
      entry = { path: file, raw, value, ...(info ? { identity: fileIdentity(info) } : {}) };
    },
    reset() { entry = undefined; },
  };
}

/** Discovery is a lot of stat calls, and /resume has to open now. This is
 * the on-disk record of what was found last time, per directory. */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../store/files.js';
import { stateDirectory } from '../store/paths.js';

/** What discovery learned about one vendor file. Everything here comes from
 * the head of an append-only transcript, so it stays true for as long as the
 * file exists; only a missing title is ever looked up again. */
export interface CachedSessionFacts { id?: string; cwd?: string; title?: string; generated?: boolean; mtimeMs?: number; size?: number }

/** One vendor directory's listing, valid while the directory's own mtime is
 * unchanged (a directory's mtime moves when entries are added or removed). */
interface CachedDirectory { mtimeMs: number; files: Record<string, CachedSessionFacts> }

interface DiscoveryCacheFile { v: 1; directories: Record<string, CachedDirectory> }

const DISCOVERY_CACHE_MAX_DIRECTORIES = 400;

export let discoveryCache: { path: string; data: DiscoveryCacheFile; dirty: boolean } | undefined;

/** Codex session id -> rollout file, filled by discovery so reading a transcript
 * is a lookup instead of a second walk of the whole tree. */
export const codexPathById = new Map<string, string>();

function discoveryCachePath(): string | undefined {
  // Tests that never relocated ClikCode's state must not touch the real one.
  if (process.env.VITEST && !process.env.CLIKCODE_HOME?.trim() && !process.env.CLIKDEPLOY_AI_HOME?.trim()) return undefined;
  return join(stateDirectory(), 'cache', 'native-discovery.json');
}

export async function loadDiscoveryCache(): Promise<DiscoveryCacheFile> {
  const path = discoveryCachePath();
  if (discoveryCache && discoveryCache.path === (path ?? '')) return discoveryCache.data;
  let data: DiscoveryCacheFile = { v: 1, directories: {} };
  if (path) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as DiscoveryCacheFile;
      if (parsed?.v === 1 && parsed.directories && typeof parsed.directories === 'object') data = parsed;
    } catch { /* fail-open-ok: a missing or damaged cache only costs one full scan. */ }
  }
  discoveryCache = { path: path ?? '', data, dirty: false };
  return data;
}

export async function saveDiscoveryCache(): Promise<void> {
  const path = discoveryCachePath();
  if (!path || !discoveryCache?.dirty || discoveryCache.path !== path) return;
  const entries = Object.entries(discoveryCache.data.directories);
  if (entries.length > DISCOVERY_CACHE_MAX_DIRECTORIES) {
    // Date-named vendor directories sort oldest first; drop those.
    discoveryCache.data.directories = Object.fromEntries(entries.sort(([left], [right]) => right.localeCompare(left)).slice(0, DISCOVERY_CACHE_MAX_DIRECTORIES));
  }
  discoveryCache.dirty = false;
  await atomicWriteFile(path, JSON.stringify(discoveryCache.data)).catch(() => undefined);
}

export function resetNativeSessionDiscoveryCache(): void {
  discoveryCache = undefined;
  codexPathById.clear();
}

/** Lists `directory`'s files with the cached facts for each, re-reading the
 * listing only when the directory changed. Returns undefined if it is gone. */
export async function cachedDirectory(directory: string, suffix: string): Promise<CachedDirectory | undefined> {
  const cache = await loadDiscoveryCache();
  const info = await stat(directory).catch(() => undefined);
  if (!info?.isDirectory()) {
    if (cache.directories[directory]) { delete cache.directories[directory]; discoveryCache!.dirty = true; }
    return undefined;
  }
  const known = cache.directories[directory];
  if (known && known.mtimeMs === info.mtimeMs) return known;
  let names: string[];
  try { names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => entry.name); } catch {
    // fail-open-ok: an unreadable optional vendor history directory has no sessions.
    return undefined;
  }
  const next: CachedDirectory = { mtimeMs: info.mtimeMs, files: Object.fromEntries(names.map((name) => [name, known?.files[name] ?? {}])) };
  cache.directories[directory] = next;
  discoveryCache!.dirty = true;
  return next;
}

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

/** What a vendor's own `sessions list` returned for one workspace last time.
 *
 * These cost a subprocess each, and most of them return nothing: measured on
 * this machine, /resume spent 2.5s spawning six CLIs, of which kilo (1.66s)
 * and qwen (0.5s) found zero sessions between them. Remembering "this one had
 * nothing here" skips the spawn until the memo expires.
 *
 * Only empty results are memoized. A harness that found something is asked
 * again every time: the cost is already justified, and a stale list is worse
 * than a slow one. */
interface CachedListing {
  at: number;
  empty: true;
  /** The vendor binary that said "nothing here". An update is exactly when a
   * CLI may start finding sessions it could not see before -- a new store
   * layout, a fixed filter -- so a memo from another build is not believed,
   * however recent. The clock remains for the one change no file shows: a
   * session started in another terminal. */
  build?: string;
}

interface DiscoveryCacheFile {
  v: 1;
  directories: Record<string, CachedDirectory>;
  listings?: Record<string, CachedListing>;
}

/** How long "nothing here" is believed. Short enough that a session created
 * in another terminal shows up in the resume list within a few minutes,
 * long enough that opening /resume repeatedly costs one spawn, not six. */
export const EMPTY_LISTING_TTL_MS = 5 * 60_000;

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
      if (parsed?.v === 1 && parsed.directories && typeof parsed.directories === 'object') {
        data = { ...parsed, listings: parsed.listings ?? {} };
      }
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
  // Expired memos are dropped rather than accumulating one key per workspace
  // per account for the life of the install. An expired entry is already
  // ignored on read, so this only keeps the file honest about its own size.
  const listings = discoveryCache.data.listings;
  if (listings) {
    const now = Date.now();
    for (const [key, entry] of Object.entries(listings)) {
      if (now - entry.at >= EMPTY_LISTING_TTL_MS) delete listings[key];
    }
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

/** Whether this harness is known to have found nothing here recently. */
export async function listingKnownEmpty(
  command: string, workspace: string | undefined, profile: string | undefined, now = Date.now(), build?: string,
): Promise<boolean> {
  const cache = await loadDiscoveryCache();
  const entry = cache.listings?.[listingKey(command, workspace, profile)];
  return Boolean(entry && entry.build === build && now - entry.at < EMPTY_LISTING_TTL_MS);
}

/** Keyed by profile as well as workspace: two accounts of the same provider
 * have separate vendor stores, so "nothing here" for one says nothing about
 * the other. Leaving the profile out would let the first empty account
 * silence every other account's sessions. */
function listingKey(command: string, workspace: string | undefined, profile: string | undefined): string {
  return `${command}\u0000${workspace ?? ''}\u0000${profile ?? ''}`;
}

/** Record what a vendor listing returned. An empty result is remembered so the
 * next /resume can skip the subprocess; a non-empty one forgets any memo, so a
 * harness that starts having sessions is never held back by an old "nothing". */
export async function rememberListing(
  command: string, workspace: string | undefined, profile: string | undefined, found: number, now = Date.now(), build?: string,
): Promise<void> {
  const cache = await loadDiscoveryCache();
  cache.listings ??= {};
  const key = listingKey(command, workspace, profile);
  if (found > 0) {
    if (cache.listings[key]) { delete cache.listings[key]; discoveryCache!.dirty = true; }
    return;
  }
  cache.listings[key] = { at: now, empty: true, ...(build ? { build } : {}) };
  discoveryCache!.dirty = true;
}

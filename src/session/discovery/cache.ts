/** Discovery is a lot of stat calls, and /resume has to open now. This is
 * the on-disk record of what was found last time, per directory. */

import { readdir, stat } from 'node:fs/promises';
import { jsonMemo } from '../store/json-memo.js';
import type { DiscoveredNativeSession } from './discovered-session.js';

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
 * and qwen (0.5s) found zero sessions between them. A recent answer stands in
 * for the next spawn -- "nothing here" for EMPTY_LISTING_TTL_MS, a list for
 * SEEN_LISTING_TTL_MS -- and the last list is shown at once while the next
 * one is asked for. */
interface CachedListing {
  at: number;
  sessions: DiscoveredNativeSession[];
  /** The vendor binary that answered. An update is exactly when a CLI may
   * start finding sessions it could not see before -- a new store layout, a
   * fixed filter -- so an answer from another build is not believed, however
   * recent. The clock remains for the one change no file shows: a session
   * started in another terminal. */
  build?: string;
}

interface DiscoveryCacheFile {
  v: 1;
  directories: Record<string, CachedDirectory>;
  /** The last answer each vendor CLI gave, per workspace and profile. (An
   * older `listings` field held the empty answers apart; it is ignored.) */
  seen?: Record<string, CachedListing>;
}

/** Enough recent answers for every CLI, account and folder in use. */
const DISCOVERY_CACHE_MAX_SEEN = 120;

/** How long "nothing here" is believed. Short enough that a session created
 * in another terminal shows up in the resume list within a few minutes,
 * long enough that opening /resume repeatedly costs one spawn, not six. */
export const EMPTY_LISTING_TTL_MS = 5 * 60_000;
/** How long a non-empty vendor listing is reused instead of spawning the CLI
 * again. Opening the conversation list is a keystroke; the CLIs are not. */
export const SEEN_LISTING_TTL_MS = 2 * 60_000;

const DISCOVERY_CACHE_MAX_DIRECTORIES = 400;

const memo = jsonMemo<DiscoveryCacheFile>('cache/native-discovery.json', () => ({ v: 1, directories: {} }), (parsed) => {
  const file = parsed as DiscoveryCacheFile;
  if (file.v !== 1 || !file.directories || typeof file.directories !== 'object') return undefined;
  return { v: 1, directories: file.directories, ...(file.seen ? { seen: file.seen } : {}) };
});

/** Codex session id -> rollout file, filled by discovery so reading a transcript
 * is a lookup instead of a second walk of the whole tree. */
export const codexPathById = new Map<string, string>();

export function loadDiscoveryCache(): Promise<DiscoveryCacheFile> { return memo.load(); }

/** Marks what discovery learned as worth writing at the next save. */
export function discoveryCacheChanged(): void { memo.changed(); }

export async function saveDiscoveryCache(): Promise<void> {
  if (!memo.dirty) return;
  const data = await memo.load();
  const entries = Object.entries(data.directories);
  if (entries.length > DISCOVERY_CACHE_MAX_DIRECTORIES) {
    // Date-named vendor directories sort oldest first; drop those.
    data.directories = Object.fromEntries(entries.sort(([left], [right]) => right.localeCompare(left)).slice(0, DISCOVERY_CACHE_MAX_DIRECTORIES));
  }
  // Expired answers are dropped rather than accumulating one key per
  // workspace per account for the life of the install. An expired entry is
  // already ignored on read, so this only keeps the file honest about its size.
  const seen = data.seen;
  if (seen) {
    const now = Date.now();
    for (const [key, entry] of Object.entries(seen)) {
      if (now - entry.at >= listingLifetime(entry)) delete seen[key];
    }
  }
  if (seen && Object.keys(seen).length > DISCOVERY_CACHE_MAX_SEEN) {
    data.seen = Object.fromEntries(Object.entries(seen).sort(([, left], [, right]) => right.at - left.at).slice(0, DISCOVERY_CACHE_MAX_SEEN));
  }
  await memo.save();
}

export function resetNativeSessionDiscoveryCache(): void {
  memo.reset();
  codexPathById.clear();
}

/** Lists `directory`'s files with the cached facts for each, re-reading the
 * listing only when the directory changed. Returns undefined if it is gone. */
export async function cachedDirectory(directory: string, suffix: string): Promise<CachedDirectory | undefined> {
  const cache = await loadDiscoveryCache();
  const info = await stat(directory).catch(() => undefined);
  if (!info?.isDirectory()) {
    if (cache.directories[directory]) { delete cache.directories[directory]; memo.changed(); }
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
  memo.changed();
  return next;
}

/** Keyed by profile as well as workspace: two accounts of the same provider
 * have separate vendor stores, so "nothing here" for one says nothing about
 * the other. Leaving the profile out would let the first empty account
 * silence every other account's sessions. */
function listingKey(command: string, workspace: string | undefined, profile: string | undefined): string {
  return `${command}\u0000${workspace ?? ''}\u0000${profile ?? ''}`;
}

function listingLifetime(entry: CachedListing): number {
  return entry.sessions.length ? SEEN_LISTING_TTL_MS : EMPTY_LISTING_TTL_MS;
}

/** Keep what a vendor CLI listed, empty or not. */
export async function rememberListing(
  command: string, workspace: string | undefined, profile: string | undefined, sessions: readonly DiscoveredNativeSession[], now = Date.now(), build?: string,
): Promise<void> {
  const cache = await loadDiscoveryCache();
  cache.seen ??= {};
  cache.seen[listingKey(command, workspace, profile)] = { at: now, sessions: [...sessions], ...(build ? { build } : {}) };
  memo.changed();
}

/** The last answer, when it is recent enough to skip the CLI and came from
 * this same binary; undefined when the CLI should be asked. */
export async function freshListing(
  command: string, workspace: string | undefined, profile: string | undefined, now = Date.now(), build?: string,
): Promise<DiscoveredNativeSession[] | undefined> {
  const cache = await loadDiscoveryCache();
  const entry = cache.seen?.[listingKey(command, workspace, profile)];
  if (!entry || entry.build !== build || now - entry.at >= listingLifetime(entry)) return undefined;
  return entry.sessions;
}

/** What a vendor CLI listed last time, or nothing when it never has. */
export async function lastSeenListing(
  command: string, workspace: string | undefined, profile: string | undefined,
): Promise<DiscoveredNativeSession[]> {
  const cache = await loadDiscoveryCache();
  return cache.seen?.[listingKey(command, workspace, profile)]?.sessions ?? [];
}

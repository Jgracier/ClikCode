/** Codex's rollout files, laid out by day. */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CachedSessionFacts, cachedDirectory, codexPathById, discoveryCache, loadDiscoveryCache, saveDiscoveryCache } from '../cache.js';
import { readFilePrefix, sortedSubdirectories } from '../files.js';
import { type NativeSessionEnvironment, nativeDataRoot } from '../stores.js';
import { conversationTitle } from '../conversation-title.js';
import { ADOPTED_TRANSCRIPT_LIMIT, extractMessageText, visibleNativeUserText } from '../transcript.js';
import { DiscoveredNativeSession } from '../discovered-session.js';

/** Codex writes one `rollout-<timestamp>-<uuid>.jsonl` file per session under
 * `~/.codex/sessions/<year>/<month>/<day>/`, not scoped by project directory —
 * `session_meta`'s own `cwd` field is what filters to this workspace. There is
 * no title field; the first real user message (skipping synthetic `<...>`
 * wrapper turns Codex injects, like recommended-plugin notices) stands in for
 * one, same convention ClikCode's own conversationTitle already uses. */
const CODEX_DISCOVERY_LIMIT = 25;

/** Always look this far back even once the limit is reached: a resumed session
 * keeps appending to its ORIGINAL date folder, so the newest activity is not
 * always in the newest folder. */
const CODEX_MIN_DAY_DIRECTORIES = 7;

const CODEX_MAX_DAY_DIRECTORIES = 180;

/** Codex has written the session id as `payload.id` and, in newer releases, as
 * both `payload.id` and `payload.session_id` (verified on 0.155.x rollouts,
 * which carry both with the same value). Either is accepted. If the meta line
 * is longer than the scanned prefix it cannot be parsed as JSON, so the fields
 * are then matched textually and the id falls back to the uuid every rollout
 * filename ends in. */
function parseCodexSessionHead(prefix: string, fileName: string): CachedSessionFacts {
  const facts: CachedSessionFacts = {};
  for (const line of prefix.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch {
      if (!facts.id && line.includes('"session_meta"')) {
        const id = /"(?:session_id|id)"\s*:\s*"([^"\\]+)"/.exec(line)?.[1];
        const cwd = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(line)?.[1];
        if (id) facts.id = id;
        if (cwd) { try { facts.cwd = JSON.parse(cwd) as string; } catch { /* leave cwd unknown */ } }
      }
      continue;
    }
    const payload = record.payload as Record<string, unknown> | undefined;
    if (record.type === 'session_meta') {
      const id = typeof payload?.id === 'string' && payload.id ? payload.id
        : typeof payload?.session_id === 'string' && payload.session_id ? payload.session_id : undefined;
      if (id) facts.id = id;
      if (typeof payload?.cwd === 'string') facts.cwd = payload.cwd;
    } else if (!facts.title && record.type === 'response_item' && payload?.role === 'user') {
      const text = visibleNativeUserText(extractMessageText(payload.content));
      if (text) facts.title = conversationTitle(text);
    }
  }
  if (!facts.id) {
    const fromName = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(fileName)?.[1];
    if (fromName) facts.id = fromName;
  }
  return facts;
}

/** Day folders (`sessions/<year>/<month>/<day>`), newest first, produced lazily
 * so a caller that stops early never lists the older part of the tree. */
async function* codexDayDirectories(root: string): AsyncGenerator<string> {
  for (const year of await sortedSubdirectories(root)) {
    for (const month of await sortedSubdirectories(join(root, year))) {
      for (const day of await sortedSubdirectories(join(root, year, month))) yield join(root, year, month, day);
    }
  }
}

export async function discoverCodexFsSessions(workspace: string, environment: NativeSessionEnvironment = {}): Promise<DiscoveredNativeSession[]> {
  const root = join(nativeDataRoot(environment, 'CODEX_HOME', join(homedir(), '.codex')), 'sessions');
  const matches: Array<DiscoveredNativeSession & { updatedAtMs: number }> = [];
  let scanned = 0;
  for await (const dir of codexDayDirectories(root)) {
    if (scanned >= CODEX_MAX_DAY_DIRECTORIES) break;
    if (scanned >= CODEX_MIN_DAY_DIRECTORIES && matches.length >= CODEX_DISCOVERY_LIMIT) break;
    scanned += 1;
    const listing = await cachedDirectory(dir, '.jsonl');
    if (!listing) continue;
    for (const name of Object.keys(listing.files)) {
      const path = join(dir, name);
      let facts = listing.files[name]!;
      // The head of a rollout never changes; only a still-missing title (a
      // session listed before its first message) is worth another look.
      if (!facts.id || !facts.title) {
        facts = parseCodexSessionHead(await readFilePrefix(path, 64_000).catch(() => ''), name);
        listing.files[name] = facts;
        discoveryCache!.dirty = true;
      }
      if (!facts.id) continue;
      codexPathById.set(`${root}\u0000${facts.id}`, path);
      // Filter by workspace BEFORE ranking: taking the newest 25 of every
      // project first meant a busy other repo could hide all of this one's chats.
      if (workspace && facts.cwd && facts.cwd !== workspace) continue;
      // Only files that survive the filter are stat-ed at all.
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      matches.push({ nativeId: facts.id, title: facts.title, updatedAt: new Date(info.mtimeMs).toISOString(), updatedAtMs: info.mtimeMs, ...(facts.cwd ? { workspace: facts.cwd } : {}) });
    }
  }
  await saveDiscoveryCache();
  return matches.sort((left, right) => right.updatedAtMs - left.updatedAtMs).slice(0, CODEX_DISCOVERY_LIMIT);
}

/** Finds a rollout by id: first the id->path map discovery just filled, then
 * the persisted listings, and only then a walk -- newest day first, names only
 * (the filename ends in the session's uuid), stopping at the first hit. */
export async function locateCodexRollout(root: string, nativeId: string): Promise<string | undefined> {
  const remembered = codexPathById.get(`${root}\u0000${nativeId}`);
  if (remembered && await stat(remembered).then(() => true, () => false)) return remembered;
  const cache = await loadDiscoveryCache();
  for (const [dir, listing] of Object.entries(cache.directories)) {
    if (!dir.startsWith(root)) continue;
    for (const [name, facts] of Object.entries(listing.files)) {
      if (facts.id !== nativeId && !name.endsWith(`${nativeId}.jsonl`)) continue;
      const path = join(dir, name);
      if (await stat(path).then(() => true, () => false)) return path;
    }
  }
  for await (const dir of codexDayDirectories(root)) {
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    const name = names.find((candidate) => candidate.endsWith(`${nativeId}.jsonl`));
    if (name) {
      codexPathById.set(`${root}\u0000${nativeId}`, join(dir, name));
      return join(dir, name);
    }
  }
  return undefined;
}

/** Reads every response_item user/assistant turn from the full rollout (the
 * discovery pass above only scans a bounded prefix, enough for a title, not a
 * transcript). */
export async function readCodexFsTranscript(nativeId: string, workspace: string, environment: NativeSessionEnvironment = {}): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const root = join(nativeDataRoot(environment, 'CODEX_HOME', join(homedir(), '.codex')), 'sessions');
  const path = await locateCodexRollout(root, nativeId);
  if (!path) return [];
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch {
    // fail-open-ok: an optional native transcript that disappeared during discovery contributes no messages.
    return [];
  }
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'response_item') continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    const role = payload?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const extracted = extractMessageText(payload?.content);
    const text = role === 'user' ? visibleNativeUserText(extracted) : extracted;
    if (!text) continue;
    messages.push({ role, content: text });
  }
  void workspace; // Codex sessions aren't project-scoped by path; discovery already filtered by cwd.
  return messages.slice(-ADOPTED_TRANSCRIPT_LIMIT);
}

/** Per-session transcript files and the filesystem primitives the split
 * ClikCode state layout is built on: private directories, fsynced atomic
 * replacement, verified lock files, and structure-only clone/compare helpers.
 *
 * A transcript is the only part of a conversation that grows without bound, so
 * it lives in `sessions/<id>.json` and is rewritten only when that one
 * conversation changes. Everything else stays in the small `index.json`. */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { HarnessSession } from './types.js';

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/** Root of all local ClikCode state. Relocatable for tests and portable installs. */
export function stateDirectory(): string {
  const clikCode = process.argv[1]?.includes('clikcode') || process.argv[1]?.includes('index-clikcode');
  return process.env.CLIKCODE_HOME?.trim()
    || process.env.CLIKDEPLOY_AI_HOME?.trim()
    || (clikCode ? join(homedir(), '.clikcode') : join(homedir(), '.clikdeploy', 'ai'));
}

export function sessionsDirectory(): string {
  return join(stateDirectory(), 'sessions');
}

/** Ids are normally UUIDs, but adopted/native ids are arbitrary strings. Anything
 * that is not a plainly safe file name is addressed by digest instead, so an id
 * can never traverse out of the directory. */
export function safeRecordFileName(id: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? id : `h-${createHash('sha256').update(id).digest('hex')}`;
}

export function sessionFilePath(id: string): string {
  return join(sessionsDirectory(), `${safeRecordFileName(id)}.json`);
}

// ---------------------------------------------------------------------------
// Private directories and durable atomic writes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Structure-only clone / compare
// ---------------------------------------------------------------------------

/** Clones containers and shares the (immutable) strings inside them. The cost
 * follows the number of objects, not the number of transcript bytes, which is
 * what makes a per-write baseline affordable. Keys holding `undefined` are
 * dropped, matching what JSON persistence would do. */
export function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneData(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = cloneData(item);
    }
    return result as T;
  }
  return value;
}

/** JSON-equivalence without serializing: `{ a: undefined }` equals `{}`. Shared
 * strings compare by pointer, so an untouched transcript costs almost nothing. */
export function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const a = left as unknown[];
    const b = right as unknown[];
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (!sameData(a[index], b[index])) return false;
    return true;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  let defined = 0;
  for (const key of Object.keys(a)) {
    if (a[key] === undefined) continue;
    defined += 1;
    if (!sameData(a[key], b[key])) return false;
  }
  let otherDefined = 0;
  for (const key of Object.keys(b)) if (b[key] !== undefined) otherDefined += 1;
  return defined === otherDefined;
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

export class StateLockTimeoutError extends Error {
  constructor(lockPath: string, holder: string | undefined, waitedMs: number) {
    super(`ClikCode could not lock its local state after ${Math.round(waitedMs / 1000)}s (${lockPath}${holder ? `, held by ${holder}` : ''}). `
      + 'Nothing was written. If no other ClikCode process is running, delete that lock file and retry.');
    this.name = 'StateLockTimeoutError';
  }
}

export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LockOwner { pid: number; host: string; nonce: string; at: string }

export const LOCK_TUNING = {
  /** A holder on another machine (shared home) can only be judged by age. */
  staleMs: 30_000,
  /** A live local pid is trusted this long before pid reuse is suspected. */
  livePidStaleMs: 5 * 60_000,
  /** Writes wait this long, then fail loudly. They never proceed unlocked. */
  waitMs: 30_000,
};

const lockQueues = new Map<string, Promise<unknown>>();

function parseLockOwner(raw: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    return typeof parsed.pid === 'number' && typeof parsed.nonce === 'string' && typeof parsed.host === 'string'
      ? parsed as LockOwner : undefined;
  } catch {
    // fail-open-ok: malformed lock metadata cannot identify a live owner; age still governs stale-lock handling
    return undefined;
  }
}

async function lockLooksStale(lockPath: string, raw: string): Promise<boolean> {
  const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs).catch(() => undefined);
  if (age === undefined) return false; // Already gone; the open will simply succeed.
  const owner = parseLockOwner(raw);
  // An empty file is a holder between create and write; only age condemns it.
  if (!owner) return age > LOCK_TUNING.staleMs;
  if (owner.host === hostname()) return pidIsAlive(owner.pid) ? age > LOCK_TUNING.livePidStaleMs : true;
  return age > LOCK_TUNING.staleMs;
}

/** Removes a stale lock without ever removing a fresh one.
 *
 * Unlinking by path is racy: two waiters both judge the lock stale, the first
 * unlinks and re-acquires, the second then unlinks the *fresh* lock. Renaming
 * to a private name is atomic, so exactly one waiter takes the file; it then
 * checks that what it took is the lock it judged, and puts it back otherwise. */
async function breakStaleLock(lockPath: string, observedRaw: string): Promise<void> {
  const current = await readFile(lockPath, 'utf8').catch(() => undefined);
  if (current !== observedRaw) return;
  const aside = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.stale`;
  try {
    await rename(lockPath, aside);
  } catch {
    return; // Another waiter already took it.
  }
  const taken = await readFile(aside, 'utf8').catch(() => undefined);
  if (taken !== observedRaw) await link(aside, lockPath).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
}

/** Cross-process mutual exclusion on `lockPath`, serialized in-process first so
 * one process never contends with itself. Not re-entrant. */
export async function withFileLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  const previous = lockQueues.get(lockPath) ?? Promise.resolve();
  const result = previous.then(() => holdFileLock(lockPath, run));
  const settled = result.catch(() => undefined);
  lockQueues.set(lockPath, settled);
  void settled.then(() => { if (lockQueues.get(lockPath) === settled) lockQueues.delete(lockPath); });
  return result;
}

async function holdFileLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(dirname(lockPath));
  const owner: LockOwner = { pid: process.pid, host: hostname(), nonce: randomBytes(12).toString('hex'), at: new Date().toISOString() };
  const mine = JSON.stringify(owner);
  const started = Date.now();
  let holder: string | undefined;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try { await handle.writeFile(mine, 'utf8'); } finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const raw = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (raw !== undefined) {
      const other = parseLockOwner(raw);
      holder = other ? `pid ${other.pid} on ${other.host}` : undefined;
      if (await lockLooksStale(lockPath, raw)) {
        await breakStaleLock(lockPath, raw);
        continue;
      }
    }
    const waited = Date.now() - started;
    // Proceeding without the lock would make the read-merge-write below
    // non-atomic and silently drop another terminal's work. Refuse instead.
    if (waited > LOCK_TUNING.waitMs) throw new StateLockTimeoutError(lockPath, holder, waited);
    await new Promise((resolve) => setTimeout(resolve, 8 + Math.floor(Math.random() * 12)));
  }
  try {
    return await run();
  } finally {
    // Only ever remove our own lock: if it was judged stale and replaced while
    // we ran, the file now belongs to someone else.
    const current = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (current === mine) await unlink(lockPath).catch(() => undefined);
  }
}

/** Same path the single-file layout used, so an older build still running in
 * another terminal keeps excluding with this one during an upgrade. */
export function stateLockPath(): string {
  return join(stateDirectory(), 'harness-state.json.lock');
}

export function withStateLock<T>(run: () => Promise<T>): Promise<T> {
  return withFileLock(stateLockPath(), run);
}

export function withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  return withFileLock(join(sessionsDirectory(), `${safeRecordFileName(sessionId)}.lock`), run);
}

// ---------------------------------------------------------------------------
// Transcript files
// ---------------------------------------------------------------------------

export type TranscriptMessage = NonNullable<HarnessSession['messages']>[number];

/** The unbounded part of a conversation, as callers see it (always materialized). */
export interface SessionTranscript {
  messages?: TranscriptMessage[];
  pendingTurn?: HarnessSession['pendingTurn'];
}

/** A fork or handoff child shares its parent's history up to an offset instead
 * of storing a second copy of it. */
export interface TranscriptRef { sessionId: string; uptoIndex: number }

interface SessionFile extends SessionTranscript {
  v: 1;
  id: string;
  transcriptRef?: TranscriptRef;
}

export const SESSION_STORE_STATS = { fileWrites: 0, fileReads: 0 };

interface CachedFile { ino: number; mtimeMs: number; ctimeMs: number; size: number; file: SessionFile }
/** Parsed files keyed by path, valid while the file's identity is unchanged.
 * Entries are never mutated; callers always receive clones. */
const fileCache = new Map<string, CachedFile>();

export function resetSessionStoreCache(): void {
  fileCache.clear();
}

export function transcriptIsEmpty(transcript: SessionTranscript): boolean {
  return transcript.messages === undefined && transcript.pendingTurn === undefined;
}

export function transcriptOf(session: HarnessSession): SessionTranscript {
  return {
    ...(session.messages !== undefined ? { messages: session.messages } : {}),
    ...(session.pendingTurn !== undefined ? { pendingTurn: session.pendingTurn } : {}),
  };
}

async function loadSessionFile(id: string): Promise<SessionFile | undefined> {
  const path = sessionFilePath(id);
  const info = await stat(path).catch(() => undefined);
  if (!info) {
    fileCache.delete(path);
    return undefined;
  }
  const cached = fileCache.get(path);
  if (cached && cached.ino === info.ino && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs && cached.size === info.size) {
    return cached.file;
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  SESSION_STORE_STATS.fileReads += 1;
  let file: SessionFile;
  try {
    const parsed = JSON.parse(raw) as SessionFile;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a session record');
    file = parsed;
  } catch {
    // Replacement is atomic, so this is external damage. Keep the bytes for
    // recovery and let the rest of the state load; one unreadable transcript
    // must not make every conversation unreachable.
    await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined);
    fileCache.delete(path);
    return undefined;
  }
  fileCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, file });
  return file;
}

async function storeSessionFile(id: string, file: SessionFile): Promise<void> {
  const path = sessionFilePath(id);
  // Compact on purpose: this is bulk data rewritten several times a second.
  await atomicWriteFile(path, JSON.stringify(file));
  SESSION_STORE_STATS.fileWrites += 1;
  const info = await stat(path).catch(() => undefined);
  if (info) fileCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, file: cloneData(file) });
  else fileCache.delete(path);
}

async function removeSessionFile(id: string): Promise<void> {
  const path = sessionFilePath(id);
  fileCache.delete(path);
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

async function materializedMessages(file: SessionFile, seen: Set<string>): Promise<TranscriptMessage[] | undefined> {
  const ref = file.transcriptRef;
  if (!ref) return file.messages;
  let inherited: TranscriptMessage[] = [];
  if (!seen.has(ref.sessionId)) {
    seen.add(ref.sessionId);
    const parent = await loadSessionFile(ref.sessionId);
    inherited = ((parent ? await materializedMessages(parent, seen) : undefined) ?? []).slice(0, ref.uptoIndex);
  }
  return [...inherited, ...(file.messages ?? [])];
}

/** Reads one conversation's transcript with any parent reference resolved. The
 * result is a private copy the caller may mutate. */
export async function readSessionTranscript(id: string): Promise<SessionTranscript> {
  const file = await loadSessionFile(id);
  if (!file) return {};
  const messages = await materializedMessages(file, new Set([id]));
  return cloneData({
    ...(messages !== undefined ? { messages } : {}),
    ...(file.pendingTurn !== undefined ? { pendingTurn: file.pendingTurn } : {}),
  });
}

export async function readSessionTranscriptRef(id: string): Promise<TranscriptRef | undefined> {
  return (await loadSessionFile(id))?.transcriptRef;
}

function sameMessage(left: TranscriptMessage | undefined, right: TranscriptMessage | undefined): boolean {
  return !!left && !!right && left.role === right.role && left.content === right.content && sameData(left, right);
}

function commonPrefixLength(left: readonly TranscriptMessage[], right: readonly TranscriptMessage[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && sameMessage(left[index], right[index])) index += 1;
  return index;
}

/** A parent's history may only ever grow while children point into it. */
function keepsHistory(before: readonly TranscriptMessage[] | undefined, after: readonly TranscriptMessage[] | undefined): boolean {
  const old = before ?? [];
  return commonPrefixLength(old, after ?? []) === old.length;
}

async function listStoredSessionIds(): Promise<string[]> {
  const names = await readdir(sessionsDirectory()).catch(() => [] as string[]);
  const ids: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(sessionsDirectory(), name);
    const cached = fileCache.get(path);
    if (cached) { ids.push(cached.file.id); continue; }
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as SessionFile;
      if (typeof parsed.id === 'string') ids.push(parsed.id);
    } catch { /* unreadable files cannot reference anything */ }
  }
  return ids;
}

/** Gives every child that points into `parentId` its own full copy. Called
 * before the parent's existing history is rewritten or removed, so a child can
 * never silently change or lose messages. Requires the state lock: that is what
 * guarantees no new reference is being created while this scans. */
export async function materializeChildrenOf(parentId: string): Promise<string[]> {
  const rewritten: string[] = [];
  for (const id of await listStoredSessionIds()) {
    if (id === parentId) continue;
    const peek = await loadSessionFile(id);
    if (!peek?.transcriptRef) continue;
    // A grandchild resolves through its own parent, which is handled here too
    // because materializing is by value: once the direct child owns its copy,
    // nothing beneath it depends on `parentId` any more.
    if (peek.transcriptRef.sessionId !== parentId) continue;
    await withSessionLock(id, async () => {
      const file = await loadSessionFile(id);
      if (!file?.transcriptRef || file.transcriptRef.sessionId !== parentId) return;
      const messages = await materializedMessages(file, new Set([id]));
      const { transcriptRef: _dropped, ...rest } = file;
      await storeSessionFile(id, { ...rest, messages: cloneData(messages ?? []) });
      rewritten.push(id);
    });
  }
  return rewritten;
}

export interface TranscriptWriteOptions {
  /** Session whose history this one may share (its fork/handoff parent). */
  parentSessionId?: string;
}

/** Below this, a reference saves nothing worth the indirection. */
const MIN_SHARED_MESSAGES = 2;

/** Persists one conversation's transcript. The caller must hold the state lock
 * (it may materialize children and create parent references). */
export async function writeSessionTranscript(id: string, next: SessionTranscript, options: TranscriptWriteOptions = {}): Promise<void> {
  await withSessionLock(id, async () => {
    const previous = await loadSessionFile(id);
    const previousMessages = previous ? await materializedMessages(previous, new Set([id])) : undefined;
    if (previous && !keepsHistory(previousMessages, next.messages)) await materializeChildrenOf(id);
    if (transcriptIsEmpty(next)) {
      await removeSessionFile(id);
      return;
    }
    const parentId = options.parentSessionId ?? previous?.transcriptRef?.sessionId;
    if (parentId && parentId !== id && next.messages && next.messages.length >= MIN_SHARED_MESSAGES) {
      const stored = await withSessionLock(parentId, async () => {
        const parent = await loadSessionFile(parentId);
        if (!parent) return false;
        // A reference must never lead back here, or both histories vanish.
        for (let hop = parent.transcriptRef, guard = 0; hop; guard += 1) {
          if (hop.sessionId === id || guard > 64) return false;
          hop = (await loadSessionFile(hop.sessionId))?.transcriptRef;
        }
        const parentMessages = await materializedMessages(parent, new Set([parentId]));
        const shared = commonPrefixLength(parentMessages ?? [], next.messages ?? []);
        if (shared < MIN_SHARED_MESSAGES) return false;
        await storeSessionFile(id, cloneData({
          v: 1 as const, id, transcriptRef: { sessionId: parentId, uptoIndex: shared },
          messages: next.messages!.slice(shared),
          ...(next.pendingTurn !== undefined ? { pendingTurn: next.pendingTurn } : {}),
        }));
        return true;
      });
      if (stored) return;
    }
    await storeSessionFile(id, cloneData({ v: 1 as const, id, ...next }));
  });
}

/** Removes a conversation's transcript, first giving its children their own copy. */
export async function deleteSessionTranscript(id: string): Promise<void> {
  await withSessionLock(id, async () => {
    await materializeChildrenOf(id);
    await removeSessionFile(id);
  });
}

/** The streaming fast path: one file, one lock, no index, no other sessions.
 *
 * `mutate` receives a private materialized copy and either edits it in place or
 * returns a replacement. Appending and updating the pending turn stay on the
 * fast path; rewriting existing history escalates to the state lock so children
 * referencing it can be given their own copy first. */
export async function writeSessionCheckpoint(
  sessionId: string,
  mutate: (transcript: SessionTranscript) => SessionTranscript | void,
): Promise<SessionTranscript> {
  const apply = async (allowRewrite: boolean): Promise<SessionTranscript | undefined> => {
    const previous = await loadSessionFile(sessionId);
    const previousMessages = previous ? await materializedMessages(previous, new Set([sessionId])) : undefined;
    const draft: SessionTranscript = cloneData({
      ...(previousMessages !== undefined ? { messages: previousMessages } : {}),
      ...(previous?.pendingTurn !== undefined ? { pendingTurn: previous.pendingTurn } : {}),
    });
    const next = mutate(draft) ?? draft;
    if (previous && !keepsHistory(previousMessages, next.messages)) {
      if (!allowRewrite) return undefined;
      await materializeChildrenOf(sessionId);
    }
    if (transcriptIsEmpty(next)) {
      await removeSessionFile(sessionId);
      return {};
    }
    const ref = previous?.transcriptRef;
    const inherited = ref ? (previousMessages ?? []).slice(0, ref.uptoIndex) : [];
    // An existing reference survives only while the inherited part is intact.
    if (ref && inherited.length === ref.uptoIndex && commonPrefixLength(inherited, next.messages ?? []) === ref.uptoIndex) {
      await storeSessionFile(sessionId, cloneData({
        v: 1 as const, id: sessionId, transcriptRef: ref, messages: (next.messages ?? []).slice(ref.uptoIndex),
        ...(next.pendingTurn !== undefined ? { pendingTurn: next.pendingTurn } : {}),
      }));
    } else {
      await storeSessionFile(sessionId, cloneData({ v: 1 as const, id: sessionId, ...next }));
    }
    return cloneData(next);
  };
  const fast = await withSessionLock(sessionId, () => apply(false));
  if (fast) return fast;
  return (await withStateLock(() => withSessionLock(sessionId, () => apply(true))))!;
}

const FORKED_FROM = Symbol('clikcode.forkedFrom');

/** Makes `child` continue from `parent`'s history without storing a second copy
 * of it. In memory the child holds ordinary materialized messages, so nothing
 * that reads it changes; on disk it records `transcriptRef` and only its own
 * messages. Returns the child for chaining. */
export function forkTranscript(parent: HarnessSession, child: HarnessSession, messages?: TranscriptMessage[]): HarnessSession {
  const inherited = messages ?? parent.messages;
  if (inherited?.length) child.messages = inherited.map((message) => ({ ...message }));
  else delete child.messages;
  child.parentSessionId ??= parent.id;
  Object.defineProperty(child, FORKED_FROM, { value: parent.id, configurable: true, writable: true, enumerable: false });
  return child;
}

export function transcriptParentOf(session: HarnessSession): string | undefined {
  return (session as HarnessSession & { [FORKED_FROM]?: string })[FORKED_FROM] ?? session.parentSessionId;
}

/** `<id>.json`: how every build before the message log stored a conversation
 * -- its whole history and running turn in one file, a fork possibly holding
 * only a reference into its parent's -- with `<id>.turn`, the newer journal of
 * a turn streaming in such a build. Read here for as long as such files
 * exist; written by this build only to give a fork its own copy before the
 * chat it refers into is deleted (transcripts.ts says why). Listing and the
 * per-process caches of both formats are here too. */

import { quiet } from '../../runtime/lifecycle-log.js';
import { readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { chatLogId, resetChatLogCache, type PendingTurn, type TranscriptMessage } from './chat-log.js';
import { atomicWriteFile } from './files.js';
import { safeRecordFileName, sessionFilePath, sessionLegacyBackupPath, sessionTurnPath, sessionsDirectory } from './paths.js';

/** A fork shares its parent's history up to an offset instead of storing a
 * second copy of it (`<id>.json` only: a log holds its own copy). */
export interface TranscriptRef { sessionId: string; uptoIndex: number }

export interface SessionFile {
  v: 1;
  id: string;
  messages?: TranscriptMessage[];
  pendingTurn?: PendingTurn;
  transcriptRef?: TranscriptRef;
}

interface CachedFile { ino: number; mtimeMs: number; ctimeMs: number; size: number; file: SessionFile }

/** Parsed files keyed by path, valid while the file's identity is unchanged. Never mutated. */
const fileCache = new Map<string, CachedFile>();

interface CachedTurn { ino: number; mtimeMs: number; ctimeMs: number; size: number; turn: PendingTurn }
const turnCache = new Map<string, CachedTurn>();

export function resetSessionStoreCache(): void {
  fileCache.clear();
  turnCache.clear();
  resetChatLogCache();
}

/** What a file is now, as one comparable string: a write of it (atomic, so a
 * new inode; or in place, so a new mtime) changes this. Not the ctime: a
 * second name given to the file (migration's hard link) changes that, and
 * the file is the same. Undefined: no such file. */
export async function fileIdentity(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(quiet('session/store/records'));
  return info ? `${info.ino}:${info.size}:${info.mtimeMs}` : undefined;
}

/** `<id>.json` parsed, or undefined (none, or damaged: then set aside as
 * `.corrupt-<time>` with its bytes kept, so one bad file cannot stop the rest
 * of the state loading). The object is the cached one: never change it. */
export async function loadLegacyFile(id: string): Promise<SessionFile | undefined> {
  const path = sessionFilePath(id);
  const info = await stat(path).catch(quiet('session/store/records'));
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
  let file: SessionFile;
  try {
    const parsed = JSON.parse(raw) as SessionFile;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a session record');
    file = parsed;
  } catch {
    // Replacement is atomic, so this is external damage.
    await rename(path, `${path}.corrupt-${Date.now()}`).catch(quiet('session/store/records'));
    fileCache.delete(path);
    return undefined;
  }
  fileCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, file });
  return file;
}

async function loadTurnFile(id: string): Promise<PendingTurn | undefined> {
  const path = sessionTurnPath(id);
  const info = await stat(path).catch(quiet('session/store/records'));
  if (!info) {
    turnCache.delete(path);
    return undefined;
  }
  const cached = turnCache.get(path);
  if (cached && cached.ino === info.ino && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs && cached.size === info.size) {
    return cached.turn;
  }
  try {
    const turn = JSON.parse(await readFile(path, 'utf8')) as PendingTurn;
    if (!turn || typeof turn !== 'object' || typeof turn.startedAt !== 'string') return undefined;
    turnCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, turn });
    return turn;
  } catch {
    // Gone meanwhile, or damaged: the journal in `<id>.json` stands.
    return undefined;
  }
}

/** `turn` continues the journal `stored` holds: the same turn, no older. Used
 * for `<id>.turn` over `<id>.json` and for `<id>.pending` over the log alike. */
export function continuesTurn(stored: PendingTurn, turn: PendingTurn): boolean {
  return turn.startedAt === stored.startedAt && turn.prompt === stored.prompt && turn.updatedAt >= stored.updatedAt;
}

/** The running turn of a stored `<id>.json`: its own journal, or the newer one
 * an older build streamed into `<id>.turn` for that same turn. */
async function legacyPendingTurn(id: string, file: SessionFile): Promise<PendingTurn | undefined> {
  // No turn running in `<id>.json`: any `<id>.turn` is a leftover, unread.
  if (!file.pendingTurn) return undefined;
  const turn = await loadTurnFile(id);
  return turn && continuesTurn(file.pendingTurn, turn) ? turn : file.pendingTurn;
}

/** Each file's history with its parent references resolved, by the parsed
 * file it came from, valid while its parent's resolved history is the very
 * array it was built from: one stat per hop decides. Never mutated. */
const materialized = new WeakMap<SessionFile, { from: readonly TranscriptMessage[] | undefined; messages: TranscriptMessage[] }>();

async function materializedMessages(file: SessionFile, seen: Set<string>, walk = { cycle: false }): Promise<TranscriptMessage[] | undefined> {
  const ref = file.transcriptRef;
  if (!ref) return file.messages;
  let parentMessages: TranscriptMessage[] | undefined;
  if (!seen.has(ref.sessionId)) {
    seen.add(ref.sessionId);
    // Always the parent's `<id>.json`, whatever format the parent is in now:
    // that is the file the reference was made into, and nothing but an older
    // build -- which keeps the referenced part as it was -- ever changes it.
    const parent = await loadLegacyFile(ref.sessionId);
    parentMessages = parent ? await materializedMessages(parent, seen, walk) : undefined;
  } else walk.cycle = true;
  const cached = materialized.get(file);
  if (cached && !walk.cycle && cached.from === parentMessages) return cached.messages;
  const messages = [...(parentMessages ?? []).slice(0, ref.uptoIndex), ...(file.messages ?? [])];
  // A walk cut short by a cycle is that walk's answer, not the file's.
  if (!walk.cycle) materialized.set(file, { from: parentMessages, messages });
  return messages;
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
}

export interface LegacyTranscript {
  /** The file read, for its identity. */
  file: SessionFile;
  /** Resolved through any parent reference; deep-frozen and shared: never change it. */
  messages: readonly TranscriptMessage[] | undefined;
  /** The cached journal itself: clone before handing it out. */
  pendingTurn: PendingTurn | undefined;
}

/** The note a chat born in the log leaves in `<id>.json` for builds that
 * predate it (transcripts.ts): theirs to show, never a message of the chat. */
function isStubNote(message: TranscriptMessage): boolean {
  return (message as { storedInLog?: unknown }).storedInLog === true;
}
const withoutStub = new WeakMap<readonly TranscriptMessage[], readonly TranscriptMessage[]>();

/** A conversation as `<id>.json` (and `<id>.turn`) hold it. */
export async function readLegacyTranscript(id: string): Promise<LegacyTranscript | undefined> {
  const file = await loadLegacyFile(id);
  if (!file) return undefined;
  let messages: readonly TranscriptMessage[] | undefined = await materializedMessages(file, new Set([id]));
  if (messages) {
    deepFreeze(messages);
    if (messages.some(isStubNote)) {
      const all = messages;
      messages = withoutStub.get(all) ?? Object.freeze(all.filter((message) => !isStubNote(message)));
      withoutStub.set(all, messages);
    }
  }
  return { file, messages, pendingTurn: await legacyPendingTurn(id, file) };
}

/** Gives every `<id>.json` that refers into `parentId`'s its own full copy,
 * written as such a build writes it. Before `parentId`'s files are deleted,
 * under the caller's state lock (no new reference is made meanwhile: only an
 * older build makes them, and it takes that lock too) and each child's own
 * lock. Returns the children rewritten. */
export async function giveLegacyChildrenTheirCopy(parentId: string, withChildLock: <T>(id: string, run: () => Promise<T>) => Promise<T>): Promise<string[]> {
  const rewritten: string[] = [];
  for (const id of await listStoredSessionIds()) {
    if (id === parentId) continue;
    const peek = await loadLegacyFile(id);
    // A grandchild resolves through its own parent, which is handled here too
    // because this is by value: once the direct child owns its copy, nothing
    // beneath it depends on `parentId` any more.
    if (peek?.transcriptRef?.sessionId !== parentId) continue;
    await withChildLock(id, async () => {
      const file = await loadLegacyFile(id);
      if (file?.transcriptRef?.sessionId !== parentId) return;
      const messages = await materializedMessages(file, new Set([id]));
      const { transcriptRef: _dropped, ...rest } = file;
      await storeLegacyFile(id, { ...rest, messages: [...(messages ?? [])] });
      rewritten.push(id);
    });
  }
  return rewritten;
}

async function storeLegacyFile(id: string, file: SessionFile): Promise<void> {
  const path = sessionFilePath(id);
  await atomicWriteFile(path, JSON.stringify(file));
  const info = await stat(path).catch(quiet('session/store/records'));
  if (info) fileCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, file });
  else fileCache.delete(path);
}

async function removeIfThere(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/** Removes `<id>.json`, `<id>.turn` and the copy kept at migration: the
 * conversation is being deleted. */
export async function removeLegacyFiles(id: string): Promise<void> {
  fileCache.delete(sessionFilePath(id));
  turnCache.delete(sessionTurnPath(id));
  await removeIfThere(sessionFilePath(id));
  await removeIfThere(sessionTurnPath(id));
  for (const name of await readdir(sessionsDirectory()).catch(() => [] as string[])) {
    if (isLegacyBackupOf(id, name)) await removeIfThere(join(sessionsDirectory(), name));
  }
}

/** `name` is one of the copies migration kept of `id`'s `<id>.json`: exactly
 * `<id>.json-v1` or `<id>.json-v1-<n>`. Exact on purpose: no other name a
 * store makes ends like that, and a prefix match could reach another chat. */
export function isLegacyBackupOf(id: string, name: string): boolean {
  const base = sessionLegacyBackupPath(id).slice(sessionsDirectory().length + 1);
  return name === base || (name.startsWith(`${base}-`) && /^\d+$/.test(name.slice(base.length + 1)));
}

/** safeRecordFileName's digest fallback, `h-<sha256 hex>`, is the only shape
 * it ever produces for an id it had to encode. A stem that does not match it
 * IS the id; one that does is read to be sure. */
const DIGEST_STEM = /^h-[0-9a-f]{64}$/;

/** Every stored session's id, in either format. */
export async function listStoredSessionIds(): Promise<string[]> {
  const names = await readdir(sessionsDirectory()).catch(() => [] as string[]);
  const ids = new Set<string>();
  for (const name of names) {
    const suffix = name.endsWith('.json') ? '.json' : name.endsWith('.jsonl') ? '.jsonl' : undefined;
    if (!suffix) continue;
    const stem = name.slice(0, -suffix.length);
    const path = join(sessionsDirectory(), name);
    if (!DIGEST_STEM.test(stem) && safeRecordFileName(stem) === stem) { ids.add(stem); continue; }
    if (suffix === '.jsonl') {
      const id = await chatLogId(path);
      if (id !== undefined) ids.add(id);
      continue;
    }
    const cached = fileCache.get(path);
    if (cached) { ids.add(cached.file.id); continue; }
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as SessionFile;
      if (typeof parsed.id === 'string') ids.add(parsed.id);
    } catch { /* unreadable files cannot reference anything */ }
  }
  return [...ids];
}

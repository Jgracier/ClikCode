/** One session's file on disk: the cache in front of it, and reading,
 * writing and removing it. */

import { readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from './files.js';
import { safeRecordFileName, sessionFilePath, sessionsDirectory } from './paths.js';
import type { SessionTranscript, TranscriptRef } from './transcripts.js';

export interface SessionFile extends SessionTranscript {
  v: 1;
  id: string;
  transcriptRef?: TranscriptRef;
}

const SESSION_STORE_STATS = { fileWrites: 0, fileReads: 0 };

interface CachedFile { ino: number; mtimeMs: number; ctimeMs: number; size: number; file: SessionFile }

/** Parsed files keyed by path, valid while the file's identity is unchanged.
 * Entries are never mutated; callers always receive clones. */
const fileCache = new Map<string, CachedFile>();

export function resetSessionStoreCache(): void {
  fileCache.clear();
}

export async function loadSessionFile(id: string): Promise<SessionFile | undefined> {
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

/** Serialized histories, by the array they were serialized from. A turn's
 * checkpoint rewrites the file several times a second with the same history
 * and a new pending turn; serializing that history again every time cost
 * time in proportion to the whole conversation. Arrays stored here are never
 * changed (see storeSessionFile), so the text stays true to them. */
const serializedMessages = new WeakMap<readonly unknown[], string>();

function serializeSessionFile(file: SessionFile): string {
  const { messages, ...rest } = file;
  if (!messages) return JSON.stringify(rest);
  let history = serializedMessages.get(messages);
  if (history === undefined) serializedMessages.set(messages, history = JSON.stringify(messages));
  const head = JSON.stringify(rest);
  return `${head.slice(0, -1)}${head.length > 2 ? ',' : ''}"messages":${history}}`;
}

/** `file` becomes the cache entry as it is: the caller hands it over and does
 * not change it afterwards. Every caller builds it fresh or passes a
 * baseline copy that nothing mutates. */
export async function storeSessionFile(id: string, file: SessionFile): Promise<void> {
  const path = sessionFilePath(id);
  // Compact on purpose: this is bulk data rewritten several times a second.
  await atomicWriteFile(path, serializeSessionFile(file));
  SESSION_STORE_STATS.fileWrites += 1;
  const info = await stat(path).catch(() => undefined);
  if (info) fileCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, file });
  else fileCache.delete(path);
}

export async function removeSessionFile(id: string): Promise<void> {
  const path = sessionFilePath(id);
  fileCache.delete(path);
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

/** safeRecordFileName's digest fallback, `h-<sha256 hex>`, is the only shape
 * it ever produces for an id it had to encode. A stem that does not match
 * this shape could therefore only have come from the identity branch (the id
 * itself, already filename-safe), so it IS that id -- recovering it costs
 * nothing. A stem that does match is ambiguous (it may be a digest, or it may
 * coincidentally be a safe id that already looked like one) and must be read
 * to be sure, exactly as before. */
const DIGEST_STEM = /^h-[0-9a-f]{64}$/;

/** Every stored session's id. Reads only what it must: for the common case
 * (a filename-safe id) the filename already is the id, so this previously
 * opened and parsed every session file on disk -- on every call -- purely to
 * learn something the name already said. Kept exact for the rare ids that
 * needed digest encoding, which still requires the file. */
export async function listStoredSessionIds(): Promise<string[]> {
  const names = await readdir(sessionsDirectory()).catch(() => [] as string[]);
  const ids: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const stem = name.slice(0, -'.json'.length);
    const path = join(sessionsDirectory(), name);
    const cached = fileCache.get(path);
    if (cached) { ids.push(cached.file.id); continue; }
    if (!DIGEST_STEM.test(stem) && safeRecordFileName(stem) === stem) { ids.push(stem); continue; }
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as SessionFile;
      if (typeof parsed.id === 'string') ids.push(parsed.id);
    } catch { /* unreadable files cannot reference anything */ }
  }
  return ids;
}

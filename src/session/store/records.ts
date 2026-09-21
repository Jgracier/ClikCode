/** One session's file on disk: the cache in front of it, and reading,
 * writing and removing it. */

import { readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { cloneData } from './data.js';
import { atomicWriteFile } from './files.js';
import { sessionFilePath, sessionsDirectory } from './paths.js';
import { SessionTranscript, TranscriptRef } from './transcripts.js';

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

export async function storeSessionFile(id: string, file: SessionFile): Promise<void> {
  const path = sessionFilePath(id);
  // Compact on purpose: this is bulk data rewritten several times a second.
  await atomicWriteFile(path, JSON.stringify(file));
  SESSION_STORE_STATS.fileWrites += 1;
  const info = await stat(path).catch(() => undefined);
  if (info) fileCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, file: cloneData(file) });
  else fileCache.delete(path);
}

export async function removeSessionFile(id: string): Promise<void> {
  const path = sessionFilePath(id);
  fileCache.delete(path);
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

export async function listStoredSessionIds(): Promise<string[]> {
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

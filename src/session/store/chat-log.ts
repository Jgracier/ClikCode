/** One conversation's messages as an append-only log, `sessions/<id>.jsonl`,
 * and its streaming journal, `sessions/<id>.pending`. The format, and how it
 * lives beside `<id>.json`, is in transcripts.ts; this file only reads and
 * writes it.
 *
 * Every line is one JSON object, ended by `\n`. The first is the header,
 * `{"v":2,"gen":"<random>","id":"<id>"}`; `gen` is new each time the file is
 * written whole, so an append is never mistaken for a new file that happens to
 * reuse an inode. Each later line is a record, applied in order:
 *
 * - `add`: messages appended to the history (`[]` says the history exists and
 *   is empty -- a chat whose messages were never set has none).
 * - `p`: the running turn's journal from here on; `null` ends it.
 * - `legacy`: how much of `<id>.json` the log has taken in (transcripts.ts).
 *
 * One record is one write: a turn's end (its prompt, its answer, the journal
 * closed) lands whole or not at all. A line without its `\n` is a write still
 * going on or one a crash cut short: it is not read, and the next append
 * starts on a fresh line so it can never join it. A complete line that does
 * not parse is skipped -- damage loses that record, never the chat.
 *
 * The streaming journal (a turn's answer so far, four times a second) is not
 * a record here: appended, it would add the whole answer again at every step;
 * overwritten in place at the log's tail, a crash mid-write can leave the
 * old record's end behind the new one's start -- a line that may even parse.
 * So it is `<id>.pending`, replaced whole by rename: a reader sees one step or
 * the next. Not `<id>.turn`, the same journal for `<id>.json` (records.ts):
 * builds that predate the log remove that file whenever they write
 * `<id>.json` and lay it over their own copy of the chat. */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import type { HarnessSession } from '../model.js';
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { atomicWriteFile } from './files.js';
import { sessionLogPath, sessionPendingPath } from './paths.js';

export type TranscriptMessage = NonNullable<HarnessSession['messages']>[number];
export type PendingTurn = NonNullable<HarnessSession['pendingTurn']>;

/** What the log has taken in of `<id>.json` (transcripts.ts, "builds that
 * predate the log"). */
export interface LegacyBase {
  /** `<id>.json` as it was then (fileIdentity), or null: there was none. */
  file: string | null;
  /** How many messages it held, and their digest (messagesDigest). */
  count: number;
  digest: string;
  /** The digest of its running turn's journal (pendingDigest). */
  pending: string;
  /** The log's message count once it had taken them in. */
  at: number;
}

export interface LogRecord {
  add?: TranscriptMessage[];
  p?: PendingTurn | null;
  legacy?: LegacyBase;
}

export const LOG_VERSION = 2;

/** One version of a log file, parsed. Never changed: a newer version is a new object. */
export interface ChatLog {
  readonly gen: string;
  /** Deep-frozen, and shared by every reader of this version. */
  readonly messages: readonly TranscriptMessage[];
  readonly hasMessages: boolean;
  readonly pending: PendingTurn | undefined;
  readonly legacy: LegacyBase | undefined;
  /** Written by a newer build (a header with another version): read as far as
   * this build understands it, and never written. */
  readonly foreign: boolean;
  readonly ino: number;
  readonly mtimeMs: number;
  /** The file's size when read, and how much of it ends in complete lines. */
  readonly size: number;
  readonly consumed: number;
  readonly skipped: number;
}

const STATS = { fullReads: 0, tailReads: 0, appends: 0, rewrites: 0, bytesRead: 0 };
export function chatLogStats(): Readonly<typeof STATS> { return STATS; }

const cache = new Map<string, ChatLog>();
export function resetChatLogCache(): void {
  cache.clear();
  pendingCache.clear();
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
}

/** `v` and `gen` first, at a fixed place: telling an append from a new file reads only that much. */
function generationPrefix(gen: string): string {
  return `{"v":${LOG_VERSION},"gen":${JSON.stringify(gen)}`;
}
function headerLine(gen: string, id: string): string {
  return `${generationPrefix(gen)},"id":${JSON.stringify(id)}}\n`;
}
const GEN_PREFIX_BYTES = 64;

interface Building {
  gen: string; foreign: boolean; added: TranscriptMessage[]; hasMessages: boolean;
  pending: PendingTurn | undefined; legacy: LegacyBase | undefined; skipped: number;
}

function applyLines(into: Building, text: string, first: boolean): void {
  let lines = text.split('\n');
  lines.pop(); // text ends with `\n`: the last piece is empty
  if (first && lines.length) {
    const header = parseLine(lines[0]!);
    if (header && 'v' in header) {
      into.gen = typeof header.gen === 'string' ? header.gen : '';
      into.foreign = header.v !== LOG_VERSION;
      lines = lines.slice(1);
    }
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = parseLine(line) as LogRecord | undefined;
    if (!record || (record.add !== undefined && !Array.isArray(record.add))) { into.skipped += 1; continue; }
    if (record.add) {
      into.hasMessages = true;
      for (const message of record.add) if (message && typeof message === 'object') into.added.push(message);
    }
    if (record.p !== undefined) into.pending = record.p && typeof record.p === 'object' ? record.p : undefined;
    if (record.legacy && typeof record.legacy === 'object') into.legacy = record.legacy;
  }
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function readRange(handle: import('node:fs/promises').FileHandle, from: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, from + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  STATS.bytesRead += done;
  return done === length ? buffer : buffer.subarray(0, done);
}

/** The log of `id` as it is on disk now, or undefined when it has none. Reads
 * only what was appended since the cached version when that is all that changed. */
export async function loadChatLog(id: string): Promise<ChatLog | undefined> {
  const path = sessionLogPath(id);
  const handle = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!handle) {
    cache.delete(path);
    return undefined;
  }
  try {
    const info = await handle.stat();
    const cached = cache.get(path);
    if (cached && cached.ino === info.ino && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached;
    let log: ChatLog;
    if (cached && cached.ino === info.ino && info.size > cached.size && cached.gen
      && (await readRange(handle, 0, GEN_PREFIX_BYTES)).toString('utf8').startsWith(generationPrefix(cached.gen))) {
      log = await readTail(handle, cached, info);
    } else log = await readWhole(handle, info);
    if (log.skipped > (cached?.gen === log.gen ? cached.skipped : 0)) lifecycle('store.log-damaged', { session: id, skipped: log.skipped });
    cache.set(path, log);
    return log;
  } finally {
    await handle.close();
  }
}

async function readWhole(handle: import('node:fs/promises').FileHandle, info: { ino: number; size: number; mtimeMs: number }): Promise<ChatLog> {
  STATS.fullReads += 1;
  const bytes = await readRange(handle, 0, info.size);
  const end = bytes.lastIndexOf(10) + 1;
  const building: Building = { gen: '', foreign: false, added: [], hasMessages: false, pending: undefined, legacy: undefined, skipped: 0 };
  applyLines(building, bytes.toString('utf8', 0, end), true);
  deepFreeze(building.added);
  return {
    gen: building.gen, messages: Object.freeze(building.added), hasMessages: building.hasMessages, pending: building.pending,
    legacy: building.legacy, foreign: building.foreign, ino: info.ino, mtimeMs: info.mtimeMs,
    size: bytes.length, consumed: end, skipped: building.skipped,
  };
}

async function readTail(handle: import('node:fs/promises').FileHandle, cached: ChatLog, info: { ino: number; size: number; mtimeMs: number }): Promise<ChatLog> {
  STATS.tailReads += 1;
  const bytes = await readRange(handle, cached.consumed, info.size - cached.consumed);
  const end = bytes.lastIndexOf(10) + 1;
  const building: Building = {
    gen: cached.gen, foreign: cached.foreign, added: [], hasMessages: cached.hasMessages, pending: cached.pending,
    legacy: cached.legacy, skipped: cached.skipped,
  };
  applyLines(building, bytes.toString('utf8', 0, end), false);
  deepFreeze(building.added);
  return {
    gen: cached.gen,
    // A new array (the one readers hold is frozen); its messages are shared.
    messages: building.added.length ? Object.freeze([...cached.messages, ...building.added]) : cached.messages,
    hasMessages: building.hasMessages, pending: building.pending, legacy: building.legacy, foreign: cached.foreign,
    ino: info.ino, mtimeMs: info.mtimeMs, size: cached.consumed + bytes.length, consumed: cached.consumed + end, skipped: building.skipped,
  };
}

function recordLine(record: LogRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** Appends records to the log `log` was read from, as one write. The caller
 * holds the conversation's lock and read `log` under it. `durable`: synced
 * before this returns (a turn's end; a streamed step is not). */
export async function appendChatLog(id: string, log: ChatLog, records: readonly LogRecord[], options: { durable: boolean }): Promise<void> {
  if (log.foreign) throw new Error(`the history of conversation ${id} was written by a newer ClikCode; this one does not change it`);
  if (!records.length) return;
  // A torn last line (a crash mid-append) is closed first, so this record starts a line of its own.
  const text = (log.consumed === log.size ? '' : '\n') + records.map(recordLine).join('');
  // Never created here: a log that is gone was removed on purpose (a delete).
  const handle = await open(sessionLogPath(id), constants.O_WRONLY | constants.O_APPEND);
  try {
    await handle.writeFile(text);
    if (options.durable) await handle.sync();
  } finally {
    await handle.close();
  }
  STATS.appends += 1;
}

export interface LogContent {
  messages?: readonly TranscriptMessage[];
  pending?: PendingTurn;
  legacy?: LegacyBase;
}

/** The text of a whole log holding `content`, one line per message. */
export function chatLogText(id: string, content: LogContent): string {
  const parts = [headerLine(randomBytes(8).toString('hex'), id)];
  if (content.legacy) parts.push(recordLine({ legacy: content.legacy }));
  if (content.messages) {
    if (!content.messages.length) parts.push(recordLine({ add: [] }));
    for (const message of content.messages) parts.push(`{"add":[${JSON.stringify(message)}]}\n`);
  }
  if (content.pending) parts.push(recordLine({ p: content.pending }));
  return parts.join('');
}

/** Replaces the whole log (a new conversation, a history rewritten: undo,
 * clear). Atomic and synced: a reader sees the old file or the new one. */
export async function writeChatLog(id: string, content: LogContent): Promise<void> {
  await atomicWriteFile(sessionLogPath(id), chatLogText(id, content));
  STATS.rewrites += 1;
}

/** Parses log text the way loadChatLog does (migration checks what it wrote). */
export function parseChatLog(text: string): Pick<ChatLog, 'messages' | 'hasMessages' | 'pending' | 'legacy' | 'skipped'> {
  const end = text.lastIndexOf('\n') + 1;
  const building: Building = { gen: '', foreign: false, added: [], hasMessages: false, pending: undefined, legacy: undefined, skipped: 0 };
  applyLines(building, text.slice(0, end), true);
  return { messages: building.added, hasMessages: building.hasMessages, pending: building.pending, legacy: building.legacy, skipped: building.skipped + (end < text.length ? 1 : 0) };
}

// ---------------------------------------------------------------------------
// The streaming journal
// ---------------------------------------------------------------------------

interface CachedPending { ino: number; mtimeMs: number; size: number; turn: PendingTurn }
const pendingCache = new Map<string, CachedPending>();

/** The running turn's journal as its answer streams, newer than the log's `p`
 * for the same turn. Replaced whole, atomically and unsynced: a crash keeps the
 * previous step, or the log's `p`. */
export async function storePendingFile(id: string, turn: PendingTurn): Promise<void> {
  const path = sessionPendingPath(id);
  await atomicWriteFile(path, JSON.stringify(turn), { durable: false });
  const info = await stat(path).catch(() => undefined);
  if (info) pendingCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size, turn });
  else pendingCache.delete(path);
}

export async function loadPendingFile(id: string): Promise<PendingTurn | undefined> {
  const path = sessionPendingPath(id);
  const info = await stat(path).catch(() => undefined);
  if (!info) {
    pendingCache.delete(path);
    return undefined;
  }
  const cached = pendingCache.get(path);
  if (cached && cached.ino === info.ino && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.turn;
  try {
    const turn = JSON.parse(await readFile(path, 'utf8')) as PendingTurn;
    if (!turn || typeof turn !== 'object' || typeof turn.startedAt !== 'string') return undefined;
    pendingCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size, turn });
    return turn;
  } catch {
    return undefined;
  }
}

export async function removePendingFile(id: string): Promise<void> {
  const path = sessionPendingPath(id);
  pendingCache.delete(path);
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function removeChatLog(id: string): Promise<void> {
  cache.delete(sessionLogPath(id));
  await unlink(sessionLogPath(id)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await removePendingFile(id);
}

/** The id a log's header names (listing a digest-named file). */
export async function chatLogId(path: string): Promise<string | undefined> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const head = (await readRange(handle, 0, 4096)).toString('utf8');
    const line = head.slice(0, head.indexOf('\n'));
    const header = parseLine(line);
    return typeof header?.id === 'string' ? header.id : undefined;
  } finally {
    await handle.close();
  }
}

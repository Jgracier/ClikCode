/** A conversation's transcript -- its messages and its running turn -- on disk.
 *
 * FORMATS
 *
 * - `<id>.jsonl`, the message log (chat-log.ts): a header, then one record per
 *   line, only ever appended to. A turn's end is one appended line; a history
 *   rewritten (undo, clear) replaces the file whole, atomically. Every chat
 *   this build writes is in this format. A fork holds its own copy of the
 *   history it was forked with (copy on fork): nothing ever refers into
 *   another chat's log, so no write of one chat ever has to touch another.
 * - `<id>.pending`: the running turn's journal while its answer streams,
 *   newer than the log's `p` record for the same turn (same prompt and start,
 *   no older). Replaced whole, unsynced, four times a second; removed by the
 *   next record that sets or ends the journal in the log.
 * - `<id>.json` (records.ts): how builds before the log stored a chat, the
 *   whole of it in one file -- a fork possibly only a reference into its
 *   parent's `<id>.json` -- with `<id>.turn`, the newer journal such a build
 *   streams. Read for as long as it exists; never written by this build,
 *   except two things, both creations or what such a build would do: the
 *   stub for a chat born here (below), and a fork's own copy before the chat
 *   its reference points into is deleted (giveLegacyChildrenTheirCopy).
 * - `<id>.json-v1`: a second name (hard link, else a copy) for `<id>.json` as
 *   it was when its chat moved to the log, so those bytes survive any later
 *   rewrite of `<id>.json`. Removed only when the chat is deleted.
 *
 * One lock per conversation, `<id>.json.lock` -- the lock builds since
 * per-session locks take to write `<id>.json` -- covers every write of these
 * files, so a migration or an intake (below) never races such a build.
 *
 * MIGRATION (lazy, lossless). A chat stays in `<id>.json` until this build
 * first writes it. Then, under the chat's lock: read `<id>.json` (its
 * identity -- inode, size, times -- the same before and after the read);
 * write the log beside it under a temporary name and sync it; read that back
 * and check it holds exactly the same messages and journal; give `<id>.json`
 * its second name; rename the log into place. Only that rename moves the
 * chat to the log: a failure or a crash at any earlier step leaves the chat
 * whole in `<id>.json`, which nothing has changed, and the next write starts
 * over. `<id>.json` itself is never changed or removed by migration. States:
 * (a) no log -- read from `<id>.json`; (b) log present -- read from the log,
 * plus whatever `<id>.json` gained since the log last took it in.
 *
 * BUILDS THAT PREDATE THE LOG (the mixed-build rule). They know `<id>.json`
 * and `<id>.turn` only, and never open, change or remove `<id>.jsonl`,
 * `<id>.pending` or `<id>.json-v1` (no name they list, sweep or delete ends
 * like those). What such a build sees:
 *
 * - a chat not yet migrated: everything, as before;
 * - a migrated chat: the chat as it was when it migrated, plus what builds
 *   like it wrote since -- nothing this build added;
 * - a chat born here: a stub `<id>.json` holding one note (marked
 *   `storedInLog`, which this build never shows or takes in) that the chat
 *   lives in a newer format. Without it such a build read the chat as empty,
 *   and its blank-chat sweep would drop it from the list.
 *
 * What such a build writes into `<id>.json` after the chat moved is taken
 * in, never lost: the log's `legacy` record says what of `<id>.json` it
 * holds (its identity, message count and digest, and journal digest). When
 * `<id>.json` is no longer that file, a read shows -- and the next write here
 * appends, with a new `legacy` record -- the messages it gained beyond that
 * many (when its first that-many are still the ones taken in; any shared with
 * what this build appended meanwhile are not repeated), and its running turn
 * if it changed it. Should it have rewritten those messages instead (an undo
 * there), the messages past the longest prefix it shares with the log are
 * taken in: an undo made in such a build is not applied here, and nothing it
 * holds is lost (`store.legacy-diverged` is logged). What such a build
 * streams into `<id>.turn` is seen here once it next writes `<id>.json`.
 *
 * WRITING. A writer hands the transcript it holds and the one it last agreed
 * with on disk (its base). History that only grew since the base is appended
 * -- O(what was added), never the history -- after anything another writer
 * appended meanwhile, without repeating what that writer already stored of
 * the same messages; the journal is recorded when the writer changed it.
 * Anything else (the writer rewrote history) is the three-way merge below,
 * and the file rewritten whole. A record that adds messages or ends the turn
 * is synced; a turn's start or a journal step is not (a crash loses at most
 * that step, never a message). */

import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HarnessSession } from '../model.js';
import { lifecycle } from '../../runtime/lifecycle-log.js';
import {
  appendChatLog, chatLogText, loadChatLog, loadPendingFile, parseChatLog, removeChatLog, removePendingFile, storePendingFile, writeChatLog,
  type ChatLog, type LegacyBase, type LogRecord, type PendingTurn, type TranscriptMessage,
} from './chat-log.js';
import { cloneData, sameData } from './data.js';
import { ensurePrivateDirectory } from './files.js';
import { withFileLock, type StateLockHeld } from './locks.js';
import { sessionFilePath, sessionLegacyBackupPath, sessionLockPath, sessionLogPath } from './paths.js';
import { continuesTurn, fileIdentity, giveLegacyChildrenTheirCopy, loadLegacyFile, readLegacyTranscript, removeLegacyFiles, type LegacyTranscript, type SessionFile } from './records.js';

export type { TranscriptRef } from './records.js';

/** The unbounded part of a conversation, as callers see it (always materialized). */
export interface SessionTranscript {
  messages?: TranscriptMessage[];
  pendingTurn?: HarnessSession['pendingTurn'];
}

export function transcriptOf(session: HarnessSession): SessionTranscript {
  return {
    ...(session.messages !== undefined ? { messages: session.messages } : {}),
    ...(session.pendingTurn !== undefined ? { pendingTurn: session.pendingTurn } : {}),
  };
}

function withSessionLock<T>(id: string, run: () => Promise<T>): Promise<T> {
  return withFileLock(sessionLockPath(id), run);
}

// ---------------------------------------------------------------------------
// Comparing histories
// ---------------------------------------------------------------------------

function sameMessage(left: TranscriptMessage | undefined, right: TranscriptMessage | undefined): boolean {
  return !!left && !!right && (left === right || (left.role === right.role && left.content === right.content && sameData(left, right)));
}

function commonPrefixLength(left: readonly TranscriptMessage[], right: readonly TranscriptMessage[]): number {
  if (left === right) return left.length;
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && sameMessage(left[index], right[index])) index += 1;
  return index;
}

function extendsHistory(prefix: readonly TranscriptMessage[], list: readonly TranscriptMessage[]): boolean {
  return list.length >= prefix.length && commonPrefixLength(prefix, list) === prefix.length;
}

/** Three-way merge of a transcript a writer rewrote: `base` the writer last
 * agreed with, `next` the writer's copy, `disk` what is stored now.
 *
 * - Disk still holds `base`: `next`.
 * - The writer only appended to `base`: disk as it is, then the writer's
 *   appended messages (any it shares with disk's own appends are not
 *   repeated). Two processes appending to one chat both keep theirs.
 * - The writer rewrote history (undo, clear) and disk only appended: the
 *   writer's history, then disk's appends -- messages the writer never saw
 *   are never silently dropped.
 * - Both rewrote: the writer's, the newer write, wins.
 *
 * The pending turn is the writer's if it changed it, otherwise disk's. */
function mergeTranscripts(base: SessionTranscript, next: SessionTranscript, disk: SessionTranscript): SessionTranscript {
  const before = base.messages ?? [];
  const mine = next.messages ?? [];
  const theirs = disk.messages ?? [];
  const iAppended = commonPrefixLength(before, mine) === before.length;
  const theyAppended = commonPrefixLength(before, theirs) === before.length;
  let messages: TranscriptMessage[] | undefined;
  if (theyAppended && theirs.length === before.length) messages = next.messages;
  else if (iAppended) {
    const ours = mine.slice(before.length);
    const theirAppends = theyAppended ? theirs.slice(before.length) : [];
    messages = [...theirs, ...ours.slice(commonPrefixLength(theirAppends, ours))];
  } else if (theyAppended) messages = [...mine, ...theirs.slice(before.length)];
  else messages = next.messages;
  const pendingTurn = sameData(base.pendingTurn, next.pendingTurn) ? disk.pendingTurn : next.pendingTurn;
  if (messages === next.messages && pendingTurn === next.pendingTurn) return next;
  return {
    ...(messages !== undefined ? { messages } : {}),
    ...(pendingTurn !== undefined ? { pendingTurn } : {}),
  };
}

/** Where a history a writer holds stands in the log: every message in it is
 * in the log of generation `gen`, which had `end` messages when that was last
 * true. A writer whose base is known here appends without comparing its
 * history with the log's at all. Arrays registered here are never changed:
 * reads hand out frozen ones and writers' bases are copies nothing mutates. */
const positions = new WeakMap<readonly TranscriptMessage[], { gen: string; end: number }>();

// ---------------------------------------------------------------------------
// Builds that predate the log: what `<id>.json` gained since it was taken in
// ---------------------------------------------------------------------------

const digests = new WeakMap<readonly TranscriptMessage[], { count: number; digest: string }>();

function messagesDigest(messages: readonly TranscriptMessage[], count = messages.length): string {
  const known = digests.get(messages);
  if (known?.count === count) return known.digest;
  const hash = createHash('sha256');
  for (let index = 0; index < count; index += 1) hash.update(JSON.stringify(messages[index])).update('\n');
  const digest = hash.digest('hex');
  digests.set(messages, { count, digest });
  return digest;
}

function pendingDigest(turn: PendingTurn | undefined): string {
  return createHash('sha256').update(JSON.stringify(turn ?? null)).digest('hex');
}

const EMPTY_BASE: Omit<LegacyBase, 'file'> = { count: 0, digest: messagesDigest([]), pending: pendingDigest(undefined), at: 0 };

interface LegacyIntake {
  /** Messages `<id>.json` gained that the log does not hold yet. */
  add: TranscriptMessage[];
  /** Its running turn, when it changed it (`turn` undefined: it ended it). */
  pending?: { turn: PendingTurn | undefined };
  /** What the log has taken in, once these are added. */
  base: LegacyBase;
  /** False: read while it changed; shown, never recorded (readLegacySteady). */
  steady: boolean;
}

/** `<id>.json` read with its identity unchanged across the read. `steady`
 * false: it kept changing (a writer that takes no chat lock), and `identity`
 * may not be the version read -- not to be recorded as taken in. */
async function readLegacySteady(id: string): Promise<{ identity: string | null; legacy: LegacyTranscript | undefined; steady: boolean }> {
  const path = sessionFilePath(id);
  let identity = (await fileIdentity(path)) ?? null;
  for (let attempt = 0; ; attempt += 1) {
    const legacy = identity === null ? undefined : await readLegacyTranscript(id);
    const after = (await fileIdentity(path)) ?? null;
    if (after === identity) return { identity, legacy, steady: true };
    if (attempt >= 4) return { identity: after, legacy, steady: false };
    identity = after;
  }
}

const intakes = new WeakMap<ChatLog, { identity: string; intake: LegacyIntake }>();

/** What `<id>.json` holds that `log` has not taken in yet, or undefined when
 * it is still the file the log last took in. Reads nothing else: one stat. */
async function legacyIntake(id: string, log: ChatLog): Promise<LegacyIntake | undefined> {
  const known = log.legacy?.file ?? null;
  const now = (await fileIdentity(sessionFilePath(id))) ?? null;
  if (now === known) return undefined;
  const memo = intakes.get(log);
  if (memo && memo.identity === now) return memo.intake;
  const { identity, legacy, steady } = await readLegacySteady(id);
  if (identity === known) return undefined;
  const base = log.legacy ?? { file: null, ...EMPTY_BASE };
  const theirs = legacy?.messages ?? [];
  let add: TranscriptMessage[] = [];
  if (!legacy) {
    // Gone, or set aside as damaged: nothing to take in, and not a delete.
  } else if (theirs.length >= base.count && messagesDigest(theirs, base.count) === base.digest) {
    const gained = theirs.slice(base.count);
    // The same messages both sides stored (a stale turn each settled) once.
    const since = log.messages.slice(Math.min(base.at, log.messages.length));
    add = gained.slice(commonPrefixLength(since, gained));
  } else {
    add = theirs.slice(commonPrefixLength(log.messages, theirs));
    lifecycle('store.legacy-diverged', { session: id, legacyMessages: theirs.length, logMessages: log.messages.length, takenIn: add.length });
  }
  const theirTurn = legacy?.pendingTurn;
  const turnChanged = legacy !== undefined && pendingDigest(theirTurn) !== base.pending;
  const intake: LegacyIntake = {
    add, steady,
    ...(turnChanged ? { pending: { turn: theirTurn } } : {}),
    base: { file: identity, count: theirs.length, digest: messagesDigest(theirs), pending: legacy ? pendingDigest(theirTurn) : base.pending, at: log.messages.length + add.length },
  };
  if (identity !== null && steady) intakes.set(log, { identity, intake });
  return intake;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface LogView { messages: readonly TranscriptMessage[] | undefined; pending: PendingTurn | undefined }

const views = new WeakMap<ChatLog, { intake: LegacyIntake; view: LogView }>();

/** The log with what `<id>.json` gained laid over it, as a reader sees it. */
function logView(log: ChatLog, intake: LegacyIntake | undefined): LogView {
  if (!intake) {
    if (log.hasMessages && !positions.has(log.messages)) positions.set(log.messages, { gen: log.gen, end: log.messages.length });
    return { messages: log.hasMessages ? log.messages : undefined, pending: log.pending };
  }
  const known = views.get(log);
  if (known?.intake === intake) return known.view;
  const view: LogView = {
    messages: intake.add.length ? Object.freeze([...log.messages, ...intake.add]) : log.hasMessages || intake.base.count ? log.messages : undefined,
    pending: intake.pending ? intake.pending.turn : log.pending,
  };
  views.set(log, { intake, view });
  return view;
}

/** The running turn's journal as readers see it: the log's, or the newer
 * streamed step of that same turn in `<id>.pending`. */
async function streamedTurn(id: string, pending: PendingTurn | undefined): Promise<PendingTurn | undefined> {
  if (!pending) return undefined;
  const streamed = await loadPendingFile(id);
  return streamed && continuesTurn(pending, streamed) ? streamed : pending;
}

/** Reads one conversation's transcript, in whichever format it is stored.
 * `messages` is the cached history, frozen: callers must not change it in
 * place (replace the array instead). `pendingTurn` is the caller's own copy. */
export async function readSessionTranscript(id: string): Promise<SessionTranscript> {
  const log = await loadChatLog(id);
  if (!log) {
    const legacy = await readLegacyTranscript(id);
    if (!legacy) return {};
    return {
      ...(legacy.messages !== undefined ? { messages: legacy.messages as TranscriptMessage[] } : {}),
      ...(legacy.pendingTurn !== undefined ? { pendingTurn: cloneData(legacy.pendingTurn) } : {}),
    };
  }
  const view = logView(log, await legacyIntake(id, log));
  const pendingTurn = await streamedTurn(id, view.pending);
  return {
    ...(view.messages !== undefined ? { messages: view.messages as TranscriptMessage[] } : {}),
    ...(pendingTurn !== undefined ? { pendingTurn: cloneData(pendingTurn) } : {}),
  };
}

/** Just the running turn's journal, as readSessionTranscript would return it (not a copy: do not change it). */
export async function readStoredPendingTurn(id: string): Promise<PendingTurn | undefined> {
  const log = await loadChatLog(id);
  if (!log) return (await readLegacyTranscript(id))?.pendingTurn;
  return streamedTurn(id, logView(log, await legacyIntake(id, log)).pending);
}

/** What a read of `id`'s messages depends on, as one string that changes
 * whenever any of those files does; undefined when the chat has no file. */
export async function transcriptIdentity(id: string): Promise<string | undefined> {
  const log = await fileIdentity(sessionLogPath(id));
  const own = await fileIdentity(sessionFilePath(id));
  if (log) return `log:${log}|json:${own ?? '-'}`;
  if (!own) return undefined;
  // A fork stored by reference reads through its parents' `<id>.json`.
  const parts = [`${id}:${own}`];
  const seen = new Set([id]);
  let ref = (await loadLegacyFile(id))?.transcriptRef;
  while (ref && !seen.has(ref.sessionId) && seen.size < 64) {
    seen.add(ref.sessionId);
    parts.push(`${ref.sessionId}:${(await fileIdentity(sessionFilePath(ref.sessionId))) ?? '-'}`);
    ref = (await loadLegacyFile(ref.sessionId))?.transcriptRef;
  }
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// Migration and the stub
// ---------------------------------------------------------------------------

/** Test hook: called at each step of a migration; throwing there is a failure (or crash) at that step. */
export const MIGRATION_FAULTS: { at?: (step: 'read' | 'write' | 'sync' | 'verify' | 'backup' | 'rename' | 'placed') => void } = {};

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r').catch(() => undefined);
  if (!handle) return;
  try { await handle.sync(); } catch { /* fail-open-ok: some filesystems refuse a directory fsync */ } finally { await handle.close(); }
}

/** A second name for `<id>.json` as it is now (see the module header). */
async function keepLegacyCopy(id: string): Promise<void> {
  const source = sessionFilePath(id);
  const sourceInfo = await stat(source);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const target = attempt === 0 ? sessionLegacyBackupPath(id) : `${sessionLegacyBackupPath(id)}-${Date.now()}${attempt}`;
    const existing = await stat(target).catch(() => undefined);
    if (existing) {
      if (existing.ino === sourceInfo.ino && existing.dev === sourceInfo.dev) return;
      continue; // an earlier copy (an earlier version of the file) is kept as it is
    }
    try {
      await link(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      // No hard links here: a copy, which never replaces anything.
      try {
        await copyFile(source, target, constants.COPYFILE_EXCL);
        return;
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw copyError;
      }
    }
  }
  throw new Error(`could not keep a copy of ${source}`);
}

/** Moves a chat from `<id>.json` to the log (see MIGRATION). Under the chat's
 * lock. Undefined, having changed nothing, when there is no `<id>.json` to move. */
async function migrate(id: string): Promise<ChatLog | undefined> {
  const fault = MIGRATION_FAULTS.at ?? (() => undefined);
  fault('read');
  const { identity, legacy, steady } = await readLegacySteady(id);
  if (!steady) throw new Error(`${sessionFilePath(id)} kept changing while it was read; the conversation stays in it until the next write`);
  if (!legacy || identity === null) return undefined;
  const messages = legacy.messages;
  const pending = legacy.pendingTurn;
  const base: LegacyBase = { file: identity, count: messages?.length ?? 0, digest: messagesDigest(messages ?? []), pending: pendingDigest(pending), at: messages?.length ?? 0 };
  const path = sessionLogPath(id);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const started = Date.now();
  let placed = false;
  try {
    await ensurePrivateDirectory(dirname(path));
    fault('write');
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(chatLogText(id, { ...(messages ? { messages } : {}), ...(pending ? { pending } : {}), legacy: base }));
      fault('sync');
      await handle.sync();
    } finally {
      await handle.close();
    }
    fault('verify');
    const back = parseChatLog(await readFile(temporary, 'utf8'));
    if (back.skipped || back.hasMessages !== (messages !== undefined) || !sameData(back.messages, messages ?? []) || !sameData(back.pending, pending) || !sameData(back.legacy, base)) {
      throw new Error(`the history of conversation ${id} did not read back as written; it stays in ${sessionFilePath(id)}`);
    }
    fault('backup');
    await keepLegacyCopy(id);
    fault('rename');
    await rename(temporary, path);
    placed = true;
  } finally {
    if (!placed) await unlink(temporary).catch(() => undefined);
  }
  fault('placed');
  await syncDirectory(dirname(path));
  const log = await loadChatLog(id);
  if (!log) throw new Error(`the history of conversation ${id} vanished as it was moved`);
  // The history just read is exactly the log's: a writer holding it appends straight on.
  if (messages && log.messages.length === messages.length) positions.set(messages, { gen: log.gen, end: messages.length });
  lifecycle('store.migrated', { session: id, messages: messages?.length ?? 0, bytes: log.size, ms: Date.now() - started });
  return log;
}

const STUB_NOTE = 'This conversation is stored in a newer format that this version of ClikCode cannot read. Update ClikCode to see it and go on with it.';

/** `<id>.json` for a chat born in the log, for builds that predate the log
 * (see the module header). Created only where there is none: linked into
 * place from a temporary, so an existing file is never replaced. */
async function writeStub(id: string): Promise<string | undefined> {
  const path = sessionFilePath(id);
  const stub: SessionFile = { v: 1, id, messages: [{ role: 'assistant', content: STUB_NOTE, storedInLog: true } as TranscriptMessage] };
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(stub)); } finally { await handle.close(); }
    await link(temporary, path);
  } catch (error) {
    // Already there (an older build wrote one meanwhile: taken in like any), or no links: no stub.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') lifecycle('store.stub-failed', { session: id, error: (error as Error).message });
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return fileIdentity(path);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function changedTurn(before: PendingTurn | undefined, after: PendingTurn | undefined): boolean {
  return !sameData(before, after);
}

/** Appends one record, synced when it adds messages or ends the turn, and
 * retires a streamed journal the record supersedes. */
async function commit(id: string, log: ChatLog, record: LogRecord): Promise<void> {
  if (record.add === undefined && record.p === undefined && record.legacy === undefined) return;
  const durable = (record.add?.length ?? 0) > 0 || record.p === null || record.legacy !== undefined;
  await appendChatLog(id, log, [record], { durable });
  if (record.p !== undefined) await removePendingFile(id);
}

/** Persists `next` as one conversation's transcript. Under that
 * conversation's lock; see WRITING in the module header. */
async function storeTranscript(id: string, next: SessionTranscript, base: SessionTranscript | undefined): Promise<void> {
  let log = await loadChatLog(id) ?? await migrate(id);
  if (!log) {
    // A conversation new to disk. Nothing in it: nothing to store.
    if (next.messages === undefined && next.pendingTurn === undefined) return;
    await writeChatLog(id, { ...(next.messages ? { messages: next.messages } : {}), ...(next.pendingTurn ? { pending: next.pendingTurn } : {}) });
    const born = await loadChatLog(id);
    if (born && next.messages) positions.set(next.messages, { gen: born.gen, end: next.messages.length });
    const stub = await writeStub(id);
    if (born && stub) await commit(id, born, { legacy: { file: stub, ...EMPTY_BASE, at: born.messages.length } });
    return;
  }
  if (log.foreign) throw new Error(`the history of conversation ${id} was written by a newer ClikCode; this one does not change it`);
  const intake = await legacyIntake(id, log);
  if (intake && !intake.steady) throw new Error(`${sessionFilePath(id)} kept changing while it was read; nothing was written`);
  if (intake) {
    await commit(id, log, {
      ...(intake.add.length ? { add: intake.add } : {}),
      ...(intake.pending ? { p: intake.pending.turn ?? null } : {}),
      legacy: intake.base,
    });
    log = (await loadChatLog(id))!;
  }
  const nextMessages = next.messages;
  const at = base?.messages ? positions.get(base.messages) : undefined;
  if (base?.messages && nextMessages && at && at.gen === log.gen && at.end <= log.messages.length && extendsHistory(base.messages, nextMessages)) {
    // Only appended since the base, which is all in the log: append the rest.
    const ours = nextMessages.slice(base.messages.length);
    const add = ours.slice(commonPrefixLength(log.messages.slice(at.end), ours));
    await commit(id, log, {
      ...(add.length ? { add } : {}),
      ...(changedTurn(base.pendingTurn, next.pendingTurn) ? { p: next.pendingTurn ?? null } : {}),
    });
    positions.set(nextMessages, { gen: log.gen, end: log.messages.length + add.length });
    return;
  }
  const disk: SessionTranscript = {
    ...(log.hasMessages ? { messages: log.messages as TranscriptMessage[] } : {}),
    ...(log.pending ? { pendingTurn: log.pending } : {}),
  };
  let merged = base ? mergeTranscripts(base, next, disk) : next;
  // A transcript whose messages were never read says nothing about them: they stay.
  if (merged.messages === undefined && disk.messages !== undefined) merged = { ...merged, messages: disk.messages };
  const diskMessages = log.messages;
  const mergedMessages = merged.messages;
  if ((mergedMessages ? extendsHistory(diskMessages, mergedMessages) : !log.hasMessages)) {
    const add = mergedMessages ? mergedMessages.slice(diskMessages.length) : undefined;
    await commit(id, log, {
      ...(add && (add.length || !log.hasMessages) ? { add } : {}),
      ...(changedTurn(log.pending, merged.pendingTurn) ? { p: merged.pendingTurn ?? null } : {}),
    });
    if (mergedMessages && mergedMessages === nextMessages) positions.set(nextMessages, { gen: log.gen, end: diskMessages.length + (add?.length ?? 0) });
    return;
  }
  // History rewritten: the whole file, atomically. What the log took in of `<id>.json` stays taken in.
  const legacy = log.legacy ? { ...log.legacy, at: Math.min(log.legacy.at, mergedMessages?.length ?? 0) } : undefined;
  await writeChatLog(id, { ...(mergedMessages ? { messages: mergedMessages } : {}), ...(merged.pendingTurn ? { pending: merged.pendingTurn } : {}), ...(legacy ? { legacy } : {}) });
  await removePendingFile(id);
  const rewritten = await loadChatLog(id);
  if (rewritten && mergedMessages && mergedMessages === nextMessages) positions.set(nextMessages, { gen: rewritten.gen, end: nextMessages.length });
}

/** Persists one conversation's transcript, under the caller's state lock and
 * that conversation's own. `base`: the transcript the writer last agreed with
 * on disk; without one, `next` replaces what is stored. */
export async function writeSessionTranscript(_held: StateLockHeld, id: string, next: SessionTranscript, options: { base?: SessionTranscript } = {}): Promise<void> {
  await withSessionLock(id, () => storeTranscript(id, next, options.base));
}

/** A conversation's transcript, written under its own lock only -- not the
 * state lock every window and worker shares. `listed` is asked under this
 * lock: a conversation deleted meanwhile is not written back (false). */
export function writeOwnTranscript(
  id: string, next: SessionTranscript, base: SessionTranscript, listed: () => Promise<boolean>,
  /** A streaming checkpoint may store just the running turn's journal (`<id>.pending`). */
  options: { journalOnly: boolean },
): Promise<boolean> {
  return withSessionLock(id, async () => {
    if (!await listed()) return false;
    if (options.journalOnly && await storeStreamedTurn(id, next, base)) return true;
    await storeTranscript(id, next, base);
    return true;
  });
}

/** A streaming turn's step: only its journal changed since `base`, and the
 * log already holds that turn. Stored in `<id>.pending` alone; false, having
 * written nothing, for anything else. */
async function storeStreamedTurn(id: string, next: SessionTranscript, base: SessionTranscript): Promise<boolean> {
  const turn = next.pendingTurn;
  if (!turn || next.messages !== base.messages || turn.startedAt !== base.pendingTurn?.startedAt) return false;
  const log = await loadChatLog(id);
  if (!log || log.foreign || !log.pending || log.pending.startedAt !== turn.startedAt || log.pending.prompt !== turn.prompt) return false;
  await storePendingFile(id, turn);
  return true;
}

/** Removes a conversation's transcript in both formats, first giving any
 * `<id>.json` fork that refers into its `<id>.json` its own copy. Under the
 * caller's state lock, like writeSessionTranscript. */
export async function deleteSessionTranscript(_held: StateLockHeld, id: string): Promise<void> {
  await giveLegacyChildrenTheirCopy(id, withSessionLock);
  await withSessionLock(id, async () => {
    await removeChatLog(id);
    await removePendingFile(id);
    await removeLegacyFiles(id);
  });
}

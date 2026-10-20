/** A conversation as a list of messages: reading one, appending to it,
 * forking it, and the shared-prefix rule that keeps a fork cheap. */

import type { HarnessSession } from '../model.js';
import { cloneData, sameData } from './data.js';
import { withFileLock, type StateLockHeld } from './locks.js';
import { sessionFilePath } from './paths.js';
import { listStoredSessionIds, loadSessionFile, removeSessionFile, storeSessionFile, storeSessionTurn, type SessionFile } from './records.js';

type TranscriptMessage = NonNullable<HarnessSession['messages']>[number];

/** The unbounded part of a conversation, as callers see it (always materialized). */
export interface SessionTranscript {
  messages?: TranscriptMessage[];
  pendingTurn?: HarnessSession['pendingTurn'];
}

/** A fork shares its parent's history up to an offset instead
 * of storing a second copy of it. */
export interface TranscriptRef { sessionId: string; uptoIndex: number }

function transcriptIsEmpty(transcript: SessionTranscript): boolean {
  return transcript.messages === undefined && transcript.pendingTurn === undefined;
}

export function transcriptOf(session: HarnessSession): SessionTranscript {
  return {
    ...(session.messages !== undefined ? { messages: session.messages } : {}),
    ...(session.pendingTurn !== undefined ? { pendingTurn: session.pendingTurn } : {}),
  };
}

/** Each file's history with its parent references resolved, by the parsed
 * file it came from, valid while its parent's resolved history is the very
 * array it was built from. A loaded file object stands for one version of
 * the file (records.ts replaces it when the file changes), and resolving
 * returns the cached array while nothing up the chain changed -- so one stat
 * per hop decides, and a parent edited in place by anything is still seen.
 * Never mutated: readers get it frozen (readSessionTranscript). */
const materialized = new WeakMap<SessionFile, { from: readonly TranscriptMessage[] | undefined; messages: TranscriptMessage[] }>();

async function materializedMessages(file: SessionFile, seen: Set<string>, walk = { cycle: false }): Promise<TranscriptMessage[] | undefined> {
  const ref = file.transcriptRef;
  if (!ref) return file.messages;
  let parentMessages: TranscriptMessage[] | undefined;
  if (!seen.has(ref.sessionId)) {
    seen.add(ref.sessionId);
    const parent = await loadSessionFile(ref.sessionId);
    parentMessages = parent ? await materializedMessages(parent, seen, walk) : undefined;
  } else walk.cycle = true;
  const cached = materialized.get(file);
  if (cached && !walk.cycle && cached.from === parentMessages) return cached.messages;
  const messages = [...(parentMessages ?? []).slice(0, ref.uptoIndex), ...(file.messages ?? [])];
  // A walk cut short by a cycle is that walk's answer, not the file's.
  if (!walk.cycle) materialized.set(file, { from: parentMessages, messages });
  return messages;
}

/** Frozen through and through, once: readers are handed the cached history
 * itself rather than a copy of it (a 27 MB conversation is 100,000-odd
 * objects), so a caller that changes it in place fails there instead of
 * changing every later read. A frozen message is also safe to share as it is
 * (state/merge.ts baselineList). */
function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
}

/** Reads one conversation's transcript with any parent reference resolved.
 * `messages` is the cached history, frozen: callers must not change it in
 * place (replace the array instead). `pendingTurn` is the caller's own copy. */
export async function readSessionTranscript(id: string): Promise<SessionTranscript> {
  const file = await loadSessionFile(id);
  if (!file) return {};
  const messages = await materializedMessages(file, new Set([id]));
  if (messages) deepFreeze(messages);
  return {
    ...(messages !== undefined ? { messages } : {}),
    ...(file.pendingTurn !== undefined ? { pendingTurn: cloneData(file.pendingTurn) } : {}),
  };
}

function sameMessage(left: TranscriptMessage | undefined, right: TranscriptMessage | undefined): boolean {
  return !!left && !!right && left.role === right.role && left.content === right.content && sameData(left, right);
}

function commonPrefixLength(left: readonly TranscriptMessage[], right: readonly TranscriptMessage[]): number {
  // The history last stored, stored again: the checkpoint of a streaming turn.
  if (left === right) return left.length;
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

/** Gives every child that points into `parentId` its own full copy. Called
 * before the parent's existing history is rewritten or removed, so a child can
 * never silently change or lose messages. Runs under the caller's state lock:
 * that is what guarantees no new reference is being created while this scans. */
async function materializeChildrenOf(parentId: string): Promise<string[]> {
  const rewritten: string[] = [];
  for (const id of await listStoredSessionIds()) {
    if (id === parentId) continue;
    const peek = await loadSessionFile(id);
    if (!peek?.transcriptRef) continue;
    // A grandchild resolves through its own parent, which is handled here too
    // because materializing is by value: once the direct child owns its copy,
    // nothing beneath it depends on `parentId` any more.
    if (peek.transcriptRef.sessionId !== parentId) continue;
    const messages = await materializedMessages(peek, new Set([id]));
    const { transcriptRef: _dropped, ...rest } = peek;
    await withSessionLock(id, () => storeSessionFile(id, { ...rest, messages: cloneData(messages ?? []) }));
    rewritten.push(id);
  }
  return rewritten;
}

interface TranscriptWriteOptions {
  /** Session whose history this one may share (its fork parent). */
  parentSessionId?: string;
  /** `next` is a baseline copy that nothing will change (state/merge.ts), so
   * it is stored as it is instead of copied again. Its unchanged history is
   * then recognised by identity on the next write (commonPrefixLength). */
  frozen?: boolean;
  /** The transcript the writer last agreed with on disk. Given, `next` is
   * merged with whatever another process stored since (mergeTranscripts)
   * instead of replacing it. */
  base?: SessionTranscript;
}

/** Each file this process stored, and the transcript it stored verbatim. A
 * file on disk that is still the one written from the writer's base needs no
 * merge -- the common case, a checkpoint following its own last write. */
const storedFrom = new WeakMap<SessionFile, SessionTranscript>();

/** Three-way merge of a transcript: `base` the writer last agreed with,
 * `next` the writer's copy, `disk` what is stored now.
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
  // Nothing of disk's to add: the writer's own copy, so what is stored is
  // recognised as written from it (storedFrom). A fresh object here made
  // every later write of a streaming turn merge again, and none ever took
  // the journal path: the whole transcript was rewritten per checkpoint.
  if (messages === next.messages && pendingTurn === next.pendingTurn) return next;
  return {
    ...(messages !== undefined ? { messages } : {}),
    ...(pendingTurn !== undefined ? { pendingTurn } : {}),
  };
}

/** Below this, a reference saves nothing worth the indirection. */
const MIN_SHARED_MESSAGES = 2;

/** Persists one conversation's transcript, under the caller's state lock (it
 * may materialize children and create parent references).
 *
 * Every session file is written only under the state lock, so no per-session
 * lock is taken. There used to be one per file, nested child->parent here and
 * parent->child in materializeChildrenOf: a lock-order cycle that only the
 * state lock around both kept from deadlocking. */
export async function writeSessionTranscript(_held: StateLockHeld, id: string, next: SessionTranscript, options: TranscriptWriteOptions = {}): Promise<void> {
  await withSessionLock(id, () => storeTranscript(id, next, options, false));
}

/** One conversation's file is written by one writer at a time (its own lock), whatever else holds
 * the shared state lock. `own`: the caller holds only this conversation's lock, so a write that
 * would reach another conversation's file -- a history shared by reference, children to give their
 * own copy -- is declined (false), for the caller to make under the state lock instead. */
async function storeTranscript(id: string, next: SessionTranscript, options: TranscriptWriteOptions, own: boolean): Promise<boolean> {
  const previous = await loadSessionFile(id);
  if (own && (options.parentSessionId || previous?.transcriptRef)) return false;
  const verbatim = next;
  // What is stored is exactly the writer's base: no merge, and history the
  // writer still holds by identity is history unchanged (a checkpoint).
  const storedBase = previous && options.base && storedFrom.get(previous) === options.base;
  let previousMessages: TranscriptMessage[] | undefined;
  const previousHistory = async (): Promise<TranscriptMessage[] | undefined> => (
    previousMessages ??= previous ? await materializedMessages(previous, new Set([id])) : undefined);
  if (options.base && previous && !storedBase) {
    next = mergeTranscripts(options.base, next, {
      ...(await previousHistory() !== undefined ? { messages: previousMessages } : {}),
      ...(previous.pendingTurn !== undefined ? { pendingTurn: previous.pendingTurn } : {}),
    });
  }
  const historyUnchanged = storedBase && next.messages === options.base!.messages;
  if (previous && !historyUnchanged && !keepsHistory(await previousHistory(), next.messages)) {
    if (own) return false;
    await materializeChildrenOf(id);
  }
  if (transcriptIsEmpty(next)) {
    if (own) return false;
    await removeSessionFile(id);
    return true;
  }
  const parentId = options.parentSessionId ?? previous?.transcriptRef?.sessionId;
  const built: SessionFile = (parentId && await referenceInto(parentId, id, next, options.frozen === true)) || { v: 1 as const, id, ...next };
  const file = options.frozen ? built : cloneData(built);
  await storeSessionFile(id, file);
  // A merged write stored something other than the writer's copy: the next
  // write from that copy must merge again, not take the fast path.
  if (next === verbatim) storedFrom.set(file, verbatim);
  return true;
}

function withSessionLock<T>(id: string, run: () => Promise<T>): Promise<T> {
  return withFileLock(`${sessionFilePath(id)}.lock`, run);
}

/** A conversation's transcript, written under its own lock only -- not the state lock every
 * window and worker shares. A turn's checkpoints and its end write the whole of a long
 * conversation (a second or more on a 20 MB one, most of it fsync); under the shared lock, every
 * other window waited for that. `listed` is asked under this lock: a conversation deleted
 * meanwhile is not written back. False, having written nothing, when the write is not this
 * conversation's alone (see storeTranscript) or it is not listed: the caller then writes it under
 * the state lock. */
export function writeOwnTranscript(
  id: string, next: SessionTranscript, base: SessionTranscript, listed: () => Promise<boolean>,
  /** A streaming checkpoint may store just the running turn's journal (storeTurn); a full write stores
   * the whole file, which is what a build that knows only `<id>.json` reads. */
  options: { journalOnly: boolean },
): Promise<boolean> {
  return withSessionLock(id, async () => {
    if (!await listed()) return false;
    if (options.journalOnly && await storeTurn(id, next, base)) return true;
    return storeTranscript(id, next, { base, frozen: true }, true);
  });
}

/** A streaming turn's checkpoint: only the running turn's journal changed
 * since `base`, which is exactly what this process last stored. Stores that
 * journal on its own (records.ts) and returns true; returns false, having
 * written nothing, for anything else -- history changed, a new turn, or a
 * file someone else has written since -- which writeSessionTranscript then
 * stores (and merges) in full. Under the caller's state lock. */
export function writeSessionTurn(_held: StateLockHeld, id: string, next: SessionTranscript, base: SessionTranscript): Promise<boolean> {
  return withSessionLock(id, () => storeTurn(id, next, base));
}

async function storeTurn(id: string, next: SessionTranscript, base: SessionTranscript): Promise<boolean> {
  if (!next.pendingTurn || next.messages !== base.messages || next.pendingTurn.startedAt !== base.pendingTurn?.startedAt) return false;
  const previous = await loadSessionFile(id);
  if (!previous || storedFrom.get(previous) !== base) return false;
  const file = await storeSessionTurn(id, next.pendingTurn);
  if (!file) return false;
  storedFrom.set(file, next);
  return true;
}

/** How much of a parent's history a child's messages share, by the parent's
 * resolved history and the child's history array: a streaming checkpoint stores the same
 * history again and again, and comparing it with the parent's every time was
 * a walk over both whole conversations per write. */
const sharedWith = new WeakMap<readonly TranscriptMessage[], { parent: readonly TranscriptMessage[]; shared: number }>();

/** `next` stored as a reference into `parentId`'s history, when that shares
 * enough of it and cannot form a cycle. `frozen`: next's arrays never change
 * (see TranscriptWriteOptions), so what they share may be remembered. */
async function referenceInto(parentId: string, id: string, next: SessionTranscript, frozen: boolean): Promise<SessionFile | undefined> {
  if (parentId === id || !next.messages || next.messages.length < MIN_SHARED_MESSAGES) return undefined;
  const parent = await loadSessionFile(parentId);
  if (!parent) return undefined;
  // A reference must never lead back here, or both histories vanish.
  for (let hop = parent.transcriptRef, guard = 0; hop; guard += 1) {
    if (hop.sessionId === id || guard > 64) return undefined;
    hop = (await loadSessionFile(hop.sessionId))?.transcriptRef;
  }
  const parentMessages = await materializedMessages(parent, new Set([parentId])) ?? [];
  const known = frozen ? sharedWith.get(next.messages) : undefined;
  let shared: number;
  if (known?.parent === parentMessages) shared = known.shared;
  else {
    shared = commonPrefixLength(parentMessages, next.messages);
    if (frozen) sharedWith.set(next.messages, { parent: parentMessages, shared });
  }
  if (shared < MIN_SHARED_MESSAGES) return undefined;
  return {
    v: 1 as const, id, transcriptRef: { sessionId: parentId, uptoIndex: shared },
    messages: next.messages.slice(shared),
    ...(next.pendingTurn !== undefined ? { pendingTurn: next.pendingTurn } : {}),
  };
}

/** Removes a conversation's transcript, first giving its children their own
 * copy. Under the caller's state lock, like writeSessionTranscript. */
export async function deleteSessionTranscript(_held: StateLockHeld, id: string): Promise<void> {
  await materializeChildrenOf(id);
  await withSessionLock(id, () => removeSessionFile(id));
}

/** A conversation as a list of messages: reading one, appending to it,
 * forking it, and the shared-prefix rule that keeps a fork cheap. */

import type { HarnessSession } from '../model.js';
import { cloneData, sameData } from './data.js';
import type { StateLockHeld } from './locks.js';
import { listStoredSessionIds, loadSessionFile, removeSessionFile, storeSessionFile, type SessionFile } from './records.js';

type TranscriptMessage = NonNullable<HarnessSession['messages']>[number];

/** The unbounded part of a conversation, as callers see it (always materialized). */
export interface SessionTranscript {
  messages?: TranscriptMessage[];
  pendingTurn?: HarnessSession['pendingTurn'];
}

/** A fork or handoff child shares its parent's history up to an offset instead
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
    await storeSessionFile(id, { ...rest, messages: cloneData(messages ?? []) });
    rewritten.push(id);
  }
  return rewritten;
}

interface TranscriptWriteOptions {
  /** Session whose history this one may share (its fork/handoff parent). */
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
export function mergeTranscripts(base: SessionTranscript, next: SessionTranscript, disk: SessionTranscript): SessionTranscript {
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
  const previous = await loadSessionFile(id);
  const previousMessages = previous ? await materializedMessages(previous, new Set([id])) : undefined;
  const verbatim = next;
  if (options.base && previous && storedFrom.get(previous) !== options.base) {
    next = mergeTranscripts(options.base, next, {
      ...(previousMessages !== undefined ? { messages: previousMessages } : {}),
      ...(previous.pendingTurn !== undefined ? { pendingTurn: previous.pendingTurn } : {}),
    });
  }
  if (previous && !keepsHistory(previousMessages, next.messages)) await materializeChildrenOf(id);
  if (transcriptIsEmpty(next)) {
    await removeSessionFile(id);
    return;
  }
  const parentId = options.parentSessionId ?? previous?.transcriptRef?.sessionId;
  const built: SessionFile = (parentId && await referenceInto(parentId, id, next)) || { v: 1 as const, id, ...next };
  const file = options.frozen ? built : cloneData(built);
  await storeSessionFile(id, file);
  // A merged write stored something other than the writer's copy: the next
  // write from that copy must merge again, not take the fast path.
  if (next === verbatim) storedFrom.set(file, verbatim);
}

/** `next` stored as a reference into `parentId`'s history, when that shares
 * enough of it and cannot form a cycle. */
async function referenceInto(parentId: string, id: string, next: SessionTranscript): Promise<SessionFile | undefined> {
  if (parentId === id || !next.messages || next.messages.length < MIN_SHARED_MESSAGES) return undefined;
  const parent = await loadSessionFile(parentId);
  if (!parent) return undefined;
  // A reference must never lead back here, or both histories vanish.
  for (let hop = parent.transcriptRef, guard = 0; hop; guard += 1) {
    if (hop.sessionId === id || guard > 64) return undefined;
    hop = (await loadSessionFile(hop.sessionId))?.transcriptRef;
  }
  const parentMessages = await materializedMessages(parent, new Set([parentId]));
  const shared = commonPrefixLength(parentMessages ?? [], next.messages);
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
  await removeSessionFile(id);
}

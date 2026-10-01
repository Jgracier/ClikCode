/** A conversation as a list of messages: reading one, appending to it,
 * forking it, and the shared-prefix rule that keeps a fork cheap. */

import type { HarnessSession } from '../model.js';
import { cloneData, sameData } from './data.js';
import { withSessionLock } from './locks.js';
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
 * never silently change or lose messages. Requires the state lock: that is what
 * guarantees no new reference is being created while this scans. */
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

interface TranscriptWriteOptions {
  /** Session whose history this one may share (its fork/handoff parent). */
  parentSessionId?: string;
  /** `next` is a baseline copy that nothing will change (state/merge.ts), so
   * it is stored as it is instead of copied again. Its unchanged history is
   * then recognised by identity on the next write (commonPrefixLength). */
  frozen?: boolean;
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
        const file: SessionFile = {
          v: 1 as const, id, transcriptRef: { sessionId: parentId, uptoIndex: shared },
          messages: next.messages!.slice(shared),
          ...(next.pendingTurn !== undefined ? { pendingTurn: next.pendingTurn } : {}),
        };
        await storeSessionFile(id, options.frozen ? file : cloneData(file));
        return true;
      });
      if (stored) return;
    }
    const file: SessionFile = { v: 1 as const, id, ...next };
    await storeSessionFile(id, options.frozen ? file : cloneData(file));
  });
}

/** Removes a conversation's transcript, first giving its children their own copy. */
export async function deleteSessionTranscript(id: string): Promise<void> {
  await withSessionLock(id, async () => {
    await materializeChildrenOf(id);
    await removeSessionFile(id);
  });
}

/** A conversation nothing has happened in yet.
 *
 * ClikCode opens a new chat on every launch, and the chat has to exist while
 * it is open -- slash commands and the turn loop address it by id. It is not
 * stored. The draft lives in this process (session/ephemeral.ts) until
 * something happens, and leaving it forgets it. There is no file to delete
 * and nothing for a later launch to sweep.
 *
 * A draft is written only at the moment it is used, and only because the
 * turn's worker is another process and has to be able to read the record.
 * "Something happened" is a message, a turn in flight, a queued message, an
 * attached file, a shell command, a user-given name, or a vendor thread it
 * was adopted from. Any one of those is the user's, and is kept.
 *
 * Older builds did write the empty chat and delete it on the way out. A
 * draft that was left on disk is still dropped the next time this process
 * writes state without that chat in hand (launch does this).
 */
import { sessionClaimIsLive } from './claim.js';
import { forceStoreSession, sessionForceStored, unforceStoreSession } from './ephemeral.js';
import { sessionFromIndex } from './list-facts.js';
import { liveWorkerSessions, type WorkerLiveness } from './liveness.js';
import type { HarnessSession } from './model.js';
import { isBlankConversation } from './options.js';
import { readState } from './state/read.js';
import { writeState } from './state/write.js';

/** How long an empty chat on disk is left alone after it was stored. Another
 * process stores one on purpose -- for its turn's worker to read, or for a
 * later command (`sessions create`) -- and the worker's first write is what
 * makes it non-empty. A sweep anywhere else in that gap deleted it. What the
 * sweeps are for, empty chats an older build left behind, is never recent. */
export const STORED_BLANK_GRACE_MS = 60 * 60_000;

/** Whether a blank-chat sweep may drop `session`. A draft only this process
 * holds can always go (nothing is on disk). A stored empty chat goes only
 * when nothing could be about to use it: not stored by this process right
 * now, no live claim, no live worker, and untouched for the grace period. */
export function blankChatSweepable(session: HarnessSession, workerIsLive: WorkerLiveness, now = Date.now()): boolean {
  if (!isBlankConversation(session)) return false;
  if (!sessionFromIndex(session)) return true;
  if (sessionForceStored(session.id) || sessionClaimIsLive(session, now) || workerIsLive(session.id)) return false;
  return now - (Date.parse(session.updatedAt) || 0) > STORED_BLANK_GRACE_MS;
}

/** Put a draft on disk. The turn worker is another process and can only see
 * what has been written; this is the moment the chat is actually used. */
export async function ensureSessionOnDisk(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session || !isBlankConversation(session)) return;
  // The grace a stored empty chat gets from other processes' sweeps runs
  // from now (blankChatSweepable).
  session.updatedAt = new Date().toISOString();
  forceStoreSession(id);
  try { await writeState(state); } finally { unforceStoreSession(id); }
}

/** Remove a conversation that was left without ever being started. A draft
 * that was never written is forgotten; a stored one only when another
 * process cannot be about to use it (blankChatSweepable). */
export async function discardIfBlank(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session || !blankChatSweepable(session, await liveWorkerSessions())) return;
  state.sessions = state.sessions.filter((item) => item.id !== id);
  await writeState(state);
}

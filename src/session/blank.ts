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
import { forceStoreSession, unforceStoreSession } from './ephemeral.js';
import { isBlankConversation } from './options.js';
import { readState } from './state/read.js';
import { writeState } from './state/write.js';

/** Put a draft on disk. The turn worker is another process and can only see
 * what has been written; this is the moment the chat is actually used. */
export async function ensureSessionOnDisk(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session || !isBlankConversation(session)) return;
  forceStoreSession(id);
  try { await writeState(state); } finally { unforceStoreSession(id); }
}

/** Remove a conversation that was left without ever being started. A draft
 * that was never written is forgotten; one an older build stored is deleted. */
export async function discardIfBlank(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session || !isBlankConversation(session)) return;
  state.sessions = state.sessions.filter((item) => item.id !== id);
  await writeState(state);
}

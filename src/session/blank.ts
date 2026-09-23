/** A conversation nothing has happened in yet.
 *
 * ClikCode opens a new chat on every launch, and the chat has to exist while
 * it is open -- the worker, the claim and every slash command address it by
 * id. What it must not do is outlive being left unused: each launch that was
 * closed without typing anything used to leave one more "Untitled chat" in
 * /resume, forever.
 *
 * So a blank chat is two things at once, and neither is a sweep:
 *
 *  - never LISTED -- judged from what the record holds, on every read, so one
 *    stranded by a killed process is as invisible as one that was never made;
 *  - DROPPED at the moment it is left (exit, /new, /resume elsewhere), which
 *    keeps the normal path from writing anything that has to be hidden.
 *
 * "Something happened" is deliberately broad: a message, a turn in flight, a
 * queued message, an attached file, a user-given name, or a vendor thread it
 * was adopted from. Any one of those is the user's, and is kept.
 */
import { isBlankConversation } from './options.js';
import { readState } from './state/read.js';
import { writeState } from './state/write.js';

export { isBlankConversation };

/** Remove a conversation that was left without ever being started. */
export async function discardIfBlank(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session || !isBlankConversation(session)) return;
  state.sessions = state.sessions.filter((item) => item.id !== id);
  await writeState(state);
}

/** Fill in list rows the index has not summarized yet. The list is already
 * on screen; this only catches conversations written before the summary
 * existed. One flight at a time. */

import { blankChatSweepable } from './blank.js';
import { sessionFromIndex, stampListFacts } from './list-facts.js';
import { liveWorkerSessions } from './liveness.js';
import { isBlankConversation } from './options.js';
import type { HarnessState } from './model.js';
import { readState } from './state/read.js';
import { writeState } from './state/write.js';

let backfill: Promise<HarnessState | undefined> | undefined;

/** One pass for the life of the process. A failure clears it so the next
 * list can try again; success stays, so opening the list twice does not
 * read every transcript twice. Resolves to the state it stored, when it
 * stored one: what a list on screen copies its new facts from. */
export function backfillListFacts(
  /** The index as the caller just read it (transcripts unread), so the list
   * that is opening does not read it a second time to decide. */
  indexed?: HarnessState,
): Promise<HarnessState | undefined> {
  // Only the call that ran the pass gets its state: one handed to a later
  // list would be older than what that list just read.
  if (backfill) return backfill.then(() => undefined);
  const pass = (async () => {
    const index = indexed ?? await readState({ transcripts: [] });
    const unchecked = index.sessions.filter((session) => !session.listChecked && !isBlankConversation(session));
    if (!unchecked.length) return undefined;
    // Only the rows still to summarize: a summarized one is judged blank or
    // not from its index facts, like everywhere else.
    const state = await readState({ transcripts: unchecked.map((session) => session.id) });
    let changed = false;
    for (const session of state.sessions) if (stampListFacts(session)) changed = true;
    // Only stored empty chats nothing could be about to use: the one
    // another process just stored for its worker is not this pass's to drop.
    const workerIsLive = await liveWorkerSessions();
    const kept = state.sessions.filter((session) => !sessionFromIndex(session) || !blankChatSweepable(session, workerIsLive));
    if (kept.length !== state.sessions.length) {
      state.sessions = kept;
      changed = true;
    }
    if (!changed) return undefined;
    await writeState(state);
    return state;
  })();
  backfill = pass;
  void pass.then(() => undefined, () => { backfill = undefined; });
  return pass;
}

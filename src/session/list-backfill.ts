/** Fill in list rows the index has not summarized yet. The list is already
 * on screen; this only catches conversations written before the summary
 * existed. One flight at a time. */

import { sessionForceStored } from './ephemeral.js';
import { sessionFromIndex, stampListFacts } from './list-facts.js';
import { isBlankConversation } from './options.js';
import { readState } from './state/read.js';
import { writeState } from './state/write.js';

let backfill: Promise<void> | undefined;

/** One pass for the life of the process. A failure clears it so the next
 * list can try again; success stays, so opening the list twice does not
 * read every transcript twice. */
export function backfillListFacts(): Promise<void> {
  if (!backfill) {
    backfill = (async () => {
      const indexed = await readState({ transcripts: [] });
      if (indexed.sessions.every((session) => session.listChecked || isBlankConversation(session))) return;
      const state = await readState();
      let changed = false;
      for (const session of state.sessions) if (stampListFacts(session)) changed = true;
      const kept = state.sessions.filter((session) => {
        if (!sessionFromIndex(session) || sessionForceStored(session.id)) return true;
        return !isBlankConversation(session);
      });
      if (kept.length !== state.sessions.length) {
        state.sessions = kept;
        changed = true;
      }
      if (changed) await writeState(state);
    })();
    void backfill.then(() => undefined, () => { backfill = undefined; });
  }
  return backfill;
}

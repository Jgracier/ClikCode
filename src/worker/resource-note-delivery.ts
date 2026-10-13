/** Where the resource guard's notes go (worker/resource-guard.ts): to ClikCode's
 * own agent, in ClikCode's words, into its running turn or its next one. A
 * vendor is never sent text ClikCode wrote; the guard's protection (stopping
 * the largest command past the line) does not depend on it. */
import { isClikCodeAgent } from '../session/route.js';
import { holdResourceNote, wrapResourceNote } from '../turn/resource-notes.js';
import type { WorkerContext } from './worker-context.js';

export function createResourceNoteDelivery(ctx: WorkerContext): (note: string) => void {
  return (note) => {
    void ctx.io.currentSessionAndAccount().then(({ session }) => {
      if (!isClikCodeAgent(session)) return undefined;
      const live = ctx.activeLiveInput;
      if (!live) { holdResourceNote(ctx.sessionId, note); return undefined; }
      return live.steerNote(wrapResourceNote(note)).then((steered) => { if (!steered) holdResourceNote(ctx.sessionId, note); });
    }).catch(() => undefined);
  };
}

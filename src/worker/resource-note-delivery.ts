/** Where the resource guard's notes go (worker/resource-guard.ts): to this
 * conversation's agent, including vendor agents, in the running turn when
 * steering is supported or in the next turn. */
import { holdResourceNote, wrapResourceNote } from '../turn/resource-notes.js';
import type { WorkerContext } from './worker-context.js';

export function createResourceNoteDelivery(ctx: WorkerContext): (note: string) => void {
  return (note) => {
    void ctx.io.currentSessionAndAccount().then(() => {
      const live = ctx.activeLiveInput;
      if (!live) { holdResourceNote(ctx.sessionId, note); return undefined; }
      return live.steerNote(wrapResourceNote(note)).then((steered) => { if (!steered) holdResourceNote(ctx.sessionId, note); });
    }).catch(() => undefined);
  };
}

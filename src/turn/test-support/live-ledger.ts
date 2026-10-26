/** A turn's saved queue as the tests see it: one list, a `steer` flag on each entry, and the steers the turn took in. */
import type { LiveTurnLedger, LiveTurnSubmission } from '../live-input.js';

export function fakeLedger(options: { failQueue?: boolean; failDelivered?: boolean } = {}) {
  const queue: Array<LiveTurnSubmission & { steer?: boolean }> = [];
  const steered: LiveTurnSubmission[] = [];
  const ledger: LiveTurnLedger = {
    queue: async (submission, steer) => { if (options.failQueue) throw new Error('disk full'); queue.push({ ...submission, ...(steer ? { steer: true } : {}) }); },
    nextSteer: () => queue.find((item) => item.steer),
    oldestMessage: () => queue[0],
    delivered: async (submission) => {
      if (options.failDelivered) throw new Error('turn is finishing');
      const at = queue.findIndex((item) => item.id === submission.id);
      if (at >= 0) queue.splice(at, 1);
      steered.push(submission);
    },
    mark: async (id) => { const item = queue.find((entry) => entry.id === id); if (item) item.steer = true; return Boolean(item); },
    remove: async (id) => { const at = queue.findIndex((item) => item.id === id); if (at >= 0) queue.splice(at, 1); return at >= 0; },
  };
  return { ledger, queue, steered };
}

/** A wait the user sees only when it is slow: the band appears after
 * SLOW_WAIT_MS, and work that finishes sooner shows nothing at all. Starting
 * and stopping a spinner at once read as a flash ("signing out · 0s" for
 * 40 ms on /logout, a blank frame on a fast `!true`). Once shown it stays
 * MIN_VISIBLE_MS at least, by the same gate (slow-wait-gate.ts). */

import { slowWaitGate } from '../harness/protocol/slow-wait-gate.js';

/** What shows the wait: the terminal's waiting band. */
export interface WaitingBand {
  startWaiting(label: string, onCancel?: (restoreDraft: boolean) => void): void;
  stopWaiting(): void;
}

export async function withSlowWait<T>(
  band: WaitingBand | undefined, label: string, work: () => Promise<T>, onCancel?: () => void,
): Promise<T> {
  if (!band) return work();
  const gate = slowWaitGate(() => band.startWaiting(label, onCancel), () => band.stopWaiting());
  try {
    return await work();
  } finally {
    await gate.end();
  }
}

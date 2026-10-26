/** Show slow operations while their work runs. */

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

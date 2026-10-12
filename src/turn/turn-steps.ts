/** Small steps several turn backends each wrote for themselves. */
import { releaseHeldVendorProcess, hasHeldVendorProcess, waitForHeldVendorSubagents } from '../harness/transport/native/held-vendor.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { DurableTurnCheckpoint } from './turn-journal.js';
import type { TurnObserver } from './observer.js';
import { recordUnfinishedInvocation } from './turn-output.js';

/** What one attempt of a turn spent, for the invocation log: the record
 * (everything but why it ended), or nothing when there is nothing to record. */
type UnfinishedAttempt = Omit<Parameters<typeof recordUnfinishedInvocation>[1], never> | undefined;

/** An attempt that ends without completing -- stopped, failed, or handed to
 * another account -- still spent what it reported. `attempt` takes that
 * usage (and clears whatever it keeps, so it is recorded once); a recorded
 * attempt touches the checkpoint when one is given. */
export function unfinishedUsageRecorder(
  state: HarnessState, checkpoint: Pick<DurableTurnCheckpoint, 'touch'> | undefined, attempt: () => UnfinishedAttempt,
): (ended: 'stopped' | 'error') => void {
  return (ended) => {
    const turn = attempt();
    if (turn && recordUnfinishedInvocation(state, turn, ended)) checkpoint?.touch();
  };
}

/** The chat enters or leaves plan mode during a turn: saved with the turn and
 * shown. `alsoOnExit` is whatever else leaving clears. */
export function setPlanMode(
  session: HarnessSession, checkpoint: Pick<DurableTurnCheckpoint, 'touch'> | undefined, prompter: TurnObserver | undefined,
  on: boolean, alsoOnExit?: () => void,
): void {
  if (on) session.planMode = true;
  else { delete session.planMode; alsoOnExit?.(); }
  checkpoint?.touch();
  prompter?.render(session);
}

/** A held vendor process may still be running Agent calls and their
 * follow-up. Wait for them, then close it so the thread is flushed before
 * anything reads or copies it. */
export async function settleHeldVendor(sessionId: string, prompter: TurnObserver | undefined, signal?: AbortSignal): Promise<void> {
  if (!hasHeldVendorProcess(sessionId)) return;
  prompter?.phase('waiting for running work');
  await waitForHeldVendorSubagents(sessionId, signal);
  await releaseHeldVendorProcess(sessionId);
}

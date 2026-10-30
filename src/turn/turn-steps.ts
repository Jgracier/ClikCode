/** Small steps several turn backends each wrote for themselves. */
import { releaseHeldVendorProcess, hasHeldVendorProcess, heldVendorOwner, retireHeldVendorProcess, waitForHeldVendorSubagents } from '../harness/transport/native/held-vendor.js';
import { reportEndedWork, retiredWorkChanged } from './vendor-process.js';
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

/** A held vendor process may still be running Agent calls and their follow-up.
 *
 * - On the account and harness the turn runs on, the turn waits for them (one process writes
 *   the thread), then closes it so the thread is flushed before anything reads or copies it.
 *   The wait has no clock: it ends on the vendor's own report of the last agent, the process
 *   exiting, or the user's Stop (`signal`).
 * - When the conversation is leaving the process (`to` is another harness or account, or the
 *   reply that started it `failed`), nothing waits on it and nothing is killed: with agents
 *   running it is retired (held-vendor.ts), they run on, and each one's end is told to the
 *   conversation as reportEndedWork does for a process a switch left (handoff-work.ts). */
export async function settleHeldVendor(
  sessionId: string, prompter: TurnObserver | undefined, signal?: AbortSignal,
  options: { failed?: boolean; to?: { harness: string; accountId: string }; from?: { harness?: string; accountId?: string } } = {},
): Promise<void> {
  if (!hasHeldVendorProcess(sessionId)) return;
  const owner = heldVendorOwner(sessionId);
  const leaving = Boolean(options.failed || (options.to && owner && (owner.harness !== options.to.harness || owner.accountId !== options.to.accountId)));
  if (leaving) {
    const from = options.from ?? owner ?? {};
    const retired = retireHeldVendorProcess(sessionId, (ended) => { reportEndedWork(sessionId, ended, { ...from, retired: true }); retiredWorkChanged(sessionId); });
    if (retired) { retiredWorkChanged(sessionId); return; }
  }
  if (!options.failed) {
    prompter?.phase('waiting for running work');
    await waitForHeldVendorSubagents(sessionId, signal);
  }
  await releaseHeldVendorProcess(sessionId);
}

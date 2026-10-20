/** Small steps several turn backends each wrote for themselves. */
import { releaseHeldVendorProcess, hasHeldVendorProcess, stopHeldVendorProcess, waitForHeldVendorSubagents } from '../harness/transport/native/held-vendor.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { reportEndedWork } from './vendor-process.js';
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

/** How long a turn waits for the agents a held vendor process is running.
 * Unbounded, a turn on a spent account waited on that account's agents for
 * an hour. */
export const HELD_AGENTS_WAIT_MS = 5 * 60_000;

/** A held vendor process may still be running Agent calls and their
 * follow-up. Wait for them (at most HELD_AGENTS_WAIT_MS; not at all with
 * `wait: false`, an attempt that failed), then close it so the thread is
 * flushed before anything reads or copies it. Agents still running then are
 * stopped with the process, and told to the conversation as cut off
 * (reportEndedWork: a notification turn on the account it is on, as for a
 * process a switch left). */
export async function settleHeldVendor(
  sessionId: string, prompter: TurnObserver | undefined, signal?: AbortSignal,
  options: { wait?: boolean; from?: { harness?: string; accountId?: string } } = {},
): Promise<void> {
  if (!hasHeldVendorProcess(sessionId)) return;
  const wait = options.wait ?? true;
  if (wait) prompter?.phase('waiting for running work');
  if (await waitForHeldVendorSubagents(sessionId, signal, wait ? HELD_AGENTS_WAIT_MS : 0)) {
    await releaseHeldVendorProcess(sessionId);
    return;
  }
  // Closing its input would leave the process waiting on them; Claude ends running Agent calls when it goes.
  await stopHeldVendorProcess(sessionId);
  const why = wait ? `ClikCode stopped it after waiting ${Math.round(HELD_AGENTS_WAIT_MS / 60_000)} minutes for it` : 'the reply that started it failed, and ClikCode stopped it';
  lifecycle('vendor.held-agents-cut-off', { waited: wait });
  reportEndedWork(sessionId, [{ id: 'held', kind: 'agent', label: 'the background agents of the last reply', outcome: 'cut-off', tail: why }], options.from);
}

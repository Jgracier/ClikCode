/** Closing sessions nothing is running any more.
 *
 * The worker closes its own session when it idles out (closeIdleSession in
 * worker/session-worker.ts), which covers the ordinary case. It cannot cover
 * the rest: a worker that is SIGKILLed, a crash, or the machine rebooting
 * never runs its shutdown path at all, so the session stays `active` with
 * nothing alive behind it. Found live: 75 of 83 sessions marked `active` with
 * three workers actually running, some claims dead for twenty hours.
 *
 * `active` has to mean "someone could be mid-conversation", because that is
 * what the interactive path and the pickers read it as. A status that only
 * ever means "has ever existed" makes every one of those judgements wrong.
 *
 * Three independent things must all say nobody is there, because any one of
 * them alone has a false positive:
 *
 *   - no live claim -- but a claim is only taken by an interactive client, so
 *     a headless `sessions send` has none and would look abandoned;
 *   - no live worker -- but a worker is spawned lazily, so a session between
 *     creation and its first turn has none;
 *   - untouched for longer than the worker's own idle window -- which is the
 *     part that makes the other two safe, since a session being set up right
 *     now is by definition recently updated.
 *
 * Closing is reversible and silent -- both resume paths reopen a closed
 * session themselves -- so the cost of being wrong here is one extra state
 * write, while the cost of never closing is that `active` stops meaning
 * anything.
 */

import { hostname } from 'node:os';
import type { HarnessSession, HarnessState } from './model.js';
import { sessionClaimIsLive } from './claim.js';

/** Matches IDLE_EXIT_MS in worker/session-worker.ts: a session cannot be
 *  judged abandoned sooner than the worker that owns it would have given up
 *  on it, or this would race a worker that is simply sitting idle. */
export const ABANDONED_AFTER_MS = 30 * 60 * 1000;

export type WorkerLiveness = (sessionId: string) => boolean;

/** Marks every session that nothing is running any more as closed, returning
 *  the ids it changed. The caller owns reading and writing state, so this stays
 *  a pure decision over a state object it was handed. */
export function closeAbandonedSessions(
  state: HarnessState,
  workerIsLive: WorkerLiveness,
  now = Date.now(),
  host = hostname(),
): string[] {
  const closed: string[] = [];
  for (const session of state.sessions ?? []) {
    if (session.status !== 'active') continue;
    if (sessionClaimIsLive(session, now, host)) continue;
    if (workerIsLive(session.id)) continue;
    const touched = Date.parse(session.updatedAt ?? '');
    // An unparseable or missing timestamp is not evidence of abandonment.
    if (!Number.isFinite(touched) || now - touched <= ABANDONED_AFTER_MS) continue;
    const at = new Date(now).toISOString();
    session.status = 'closed';
    session.closedAt = at;
    session.updatedAt = at;
    closed.push(session.id);
  }
  return closed;
}

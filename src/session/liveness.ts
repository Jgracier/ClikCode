/** Whether anything is actually running a session -- computed, never stored.
 *
 * This replaces a `status = 'closed'` written by the worker plus a sweep that
 * closed sessions nothing was running. Both were wrong in the same way: they
 * cached a fact that is cheap to compute, and then needed machinery to notice
 * the cache had gone stale. A process that is SIGKILLed cannot update a cache,
 * so the sweep was not an oversight to be tidied up -- it was load-bearing for
 * a design that should not have cached in the first place.
 *
 * `status` means exactly one thing again: what the USER decided. `closed` is
 * the close command, `archived` is /archive, and nothing else writes it. It is
 * intent, it is durable, and no background process gets to overrule it.
 *
 * Liveness is the other question, and it is derived from the two records that
 * already answer it and already expire on their own:
 *
 *   - the claim store -- a heartbeat with a TTL, plus pid liveness on this
 *     host, which is what lets another terminal take a crashed session over;
 *   - the worker registry -- a record naming a pid, which either exists or
 *     does not.
 *
 * Neither can be stale, because neither is a copy of anything: a dead pid is
 * simply not alive, whenever you ask. So there is nothing to reconcile, no
 * idle window to agree on in two places, and no window in which a record and
 * reality disagree.
 *
 * This is the pattern the claim store already used and that status never
 * followed -- `session.claim` is itself only a view projected on read, and
 * claimIsHeld computes rather than remembers.
 */

import { hostname } from 'node:os';
import type { HarnessSession } from './model.js';
import { sessionClaimIsLive } from './claim.js';

/** Whether a worker process exists for a session id. Supplied by the caller so
 *  one filesystem pass answers for a whole list. */
export type WorkerLiveness = (sessionId: string) => boolean;

/** True when some process is running this session right now.
 *
 *  Either signal alone is enough, and neither alone is sufficient: an
 *  interactive client takes a claim but a headless `sessions send` does not,
 *  while a worker exists for both but is spawned lazily, so a session between
 *  creation and its first turn has neither. That is not a gap -- a session
 *  nothing is running is exactly what this reports. */
export function sessionIsLive(
  session: HarnessSession,
  workerIsLive: WorkerLiveness,
  now = Date.now(),
  host = hostname(),
): boolean {
  if (session.status !== 'active') return false;
  return sessionClaimIsLive(session, now, host) || workerIsLive(session.id);
}

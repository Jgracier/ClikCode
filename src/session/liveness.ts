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
import { listWorkerRecords } from '../worker/registry.js';
import { loadSessionFile } from './store/records.js';

type PendingTurn = NonNullable<HarnessSession['pendingTurn']>;

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

/** Which sessions still have a worker process behind them.
 *
 * Reads the worker directory once and checks those PIDs. Passing every chat
 * and opening each chat's record was O(conversations) for a handful of live
 * workers; the directory is O(workers). */
export async function liveWorkerSessions(): Promise<(sessionId: string) => boolean> {
  return (await liveWorkers()).isLive;
}

/** The same pass, and which live workers have an approval waiting on the
 * user: the record a worker keeps beside its pid (onAwaitingApproval), so a
 * list can say a conversation needs the user without attaching to it. */
export async function liveWorkers(): Promise<{ isLive: WorkerLiveness; awaitingYou: (sessionId: string) => boolean }> {
  const live = new Set<string>();
  const awaiting = new Set<string>();
  const records = await listWorkerRecords().catch(() => []);
  await Promise.all(records.map(async (record) => {
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      // EPERM means it exists and belongs to someone else, which still counts.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') return;
    }
    live.add(record.sessionId);
    if (record.awaitingApproval) awaiting.add(record.sessionId);
  }));
  return { isLive: (sessionId) => live.has(sessionId), awaitingYou: (sessionId) => awaiting.has(sessionId) };
}

/** The turn each live-worker session is generating, read from its transcript.
 *
 * The transcript's `pendingTurn` is the one record of a turn in flight; the
 * worker writes it and clears it. Only sessions with a live worker are read
 * (O(workers), not O(conversations)): a journal behind no process is a crash
 * left for recovery, not a turn running. Its `updatedAt` is the pace. */
export async function livePendingTurns(
  sessions: readonly HarnessSession[],
  workerIsLive: WorkerLiveness,
): Promise<Map<string, PendingTurn>> {
  const pending = new Map<string, PendingTurn>();
  await Promise.all(sessions.filter((session) => session.status === 'active' && workerIsLive(session.id)).map(async (session) => {
    const turn = (await loadSessionFile(session.id).catch(() => undefined))?.pendingTurn;
    if (turn && !turn.failedAt) pending.set(session.id, turn);
  }));
  return pending;
}

/** What a live session is doing: `working` while a turn is in flight
 * (generating), `idle` when something holds it open between turns, undefined
 * when nothing does.
 *
 * A turn in flight is the transcript's `pendingTurn` (`pending`; by default
 * the loaded one, a list passes what livePendingTurns read). It is only
 * trusted behind a live worker: a crash leaves the journal behind on purpose
 * (recovery), so on its own it would animate a dead chat. */
export function sessionActivity(
  session: HarnessSession,
  workerIsLive: WorkerLiveness,
  now = Date.now(),
  host = hostname(),
  pending: HarnessSession['pendingTurn'] = session.pendingTurn,
): 'working' | 'idle' | undefined {
  if (!sessionIsLive(session, workerIsLive, now, host)) return undefined;
  return pending && !pending.failedAt && workerIsLive(session.id) ? 'working' : 'idle';
}

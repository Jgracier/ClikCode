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
 * Liveness is the other question, and it is derived from the one registry
 * (worker/registry.ts) that already answers it and expires on its own:
 *
 *   - a worker record, alive while its worker's lease is (registry.ts workerAlive);
 *   - a presence record (`client`) for a terminal or editor chat open with no
 *     worker yet, judged by the same owner liveness rule as a worker's hold.
 *
 * Neither can be stale, because neither is a copy of anything: a dead pid is
 * simply not alive, whenever you ask. So there is nothing to reconcile.
 */

import { describeCommands } from '../harness/protocol/background-agents.js';
import { quiet } from '../runtime/lifecycle-log.js';
import type { HarnessSession } from './model.js';
import { liveOpenConversations, liveWorkerRecords, type WorkerRuntimeRecord } from '../worker/registry.js';
import { readStoredPendingTurn } from './store/transcripts.js';

type PendingTurn = NonNullable<HarnessSession['pendingTurn']>;

/** The background work a live worker reports for a session (its record). */
export type BackgroundOf = (sessionId: string) => WorkerRuntimeRecord['background'];

/** Whether a worker process exists for a session id. Supplied by the caller so
 *  one filesystem pass answers for a whole list. */
export type WorkerLiveness = (sessionId: string) => boolean;
export type RunningTurnLookup = (sessionId: string) => string | undefined;

/** True when some process is running this session right now.
 *
 *  Either signal alone is enough, and neither alone is sufficient: an
 *  interactive client records presence but a headless `sessions send` does not,
 *  while a worker exists for both but is spawned lazily, so a session between
 *  creation and its first turn has neither. That is not a gap -- a session
 *  nothing is running is exactly what this reports. */
export function sessionIsLive(
  session: HarnessSession,
  workerIsLive: WorkerLiveness,
  isOpen: WorkerLiveness = () => false,
): boolean {
  if (session.status !== 'active') return false;
  return isOpen(session.id) || workerIsLive(session.id);
}

/** Which sessions still have a worker process behind them, and which of those
 * have an approval waiting on the user: the record a worker keeps beside its
 * pid (onAwaitingApproval), so a list can say a conversation needs the user
 * without attaching to it.
 *
 * Reads the worker directory once and checks those leases. Passing every chat
 * and opening each chat's record was O(conversations) for a handful of live
 * workers; the directory is O(workers). */
export async function liveWorkers(): Promise<{ isLive: WorkerLiveness; isOpen: WorkerLiveness; awaitingYou: (sessionId: string) => boolean; awaitingApproval: (sessionId: string) => WorkerRuntimeRecord['awaitingApproval']; background: BackgroundOf; runningTurn: RunningTurnLookup }> {
  const [records, isOpen] = await Promise.all([liveWorkerRecords().catch(() => []), liveOpenConversations().catch(() => () => false)]);
  const bySession = new Map(records.map((record) => [record.sessionId, record]));
  return {
    isLive: (sessionId) => bySession.has(sessionId),
    isOpen,
    awaitingYou: (sessionId) => Boolean(bySession.get(sessionId)?.awaitingApproval),
    awaitingApproval: (sessionId) => bySession.get(sessionId)?.awaitingApproval,
    background: (sessionId) => bySession.get(sessionId)?.background,
    runningTurn: (sessionId) => bySession.get(sessionId)?.runningTurn?.since || undefined,
  };
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
  /** Work the vendor still runs for a chat whose own turn is over (liveWorkers). */
  background: BackgroundOf = () => undefined,
  runningTurn: RunningTurnLookup = () => undefined,
): Promise<Map<string, PendingTurn>> {
  const pending = new Map<string, PendingTurn>();
  await Promise.all(sessions.filter((session) => session.status === 'active' && workerIsLive(session.id)).map(async (session) => {
    const startedAt = runningTurn(session.id);
    if (startedAt) {
      const turn = await readStoredPendingTurn(session.id).catch(quiet('session/liveness'));
      pending.set(session.id, turn && !turn.failedAt ? turn : {
        prompt: '', startedAt, updatedAt: startedAt, outputStarted: false,
      });
      return;
    }
    const work = background(session.id);
    if (work) pending.set(session.id, backgroundAsTurn(work));
  }));
  return pending;
}

/** A chat waiting on background agents, workflows or terminals is still working: a list shows it as a turn in flight, its agents as its sub-agents. */
function backgroundAsTurn(work: NonNullable<WorkerRuntimeRecord['background']>): PendingTurn {
  return {
    prompt: '', startedAt: work.since, updatedAt: new Date().toISOString(), outputStarted: true,
    // Said as it is: a command all that runs is waited on, not thought about.
    ...(describeCommands(work.commands ?? []) ? { waitingOn: describeCommands(work.commands ?? [])! } : {}),
    subagents: Array.from({ length: work.agents ?? 0 }, (_, index) => ({ id: `background-${index}`, label: 'background agent', startedAt: work.since })),
  };
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
  pending: HarnessSession['pendingTurn'] = session.pendingTurn,
  isOpen: WorkerLiveness = () => false,
  runningTurn: RunningTurnLookup = () => undefined,
  background: BackgroundOf = () => undefined,
): 'working' | 'idle' | undefined {
  if (!sessionIsLive(session, workerIsLive, isOpen)) return undefined;
  return pending && !pending.failedAt && (runningTurn(session.id) || background(session.id)) ? 'working' : 'idle';
}

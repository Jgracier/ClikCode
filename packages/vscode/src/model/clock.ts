/** The live turn's clock: its time less what approvals waited. */
import { resumeTurnClock, turnElapsedMs, type TurnClock } from '../../../../src/harness/protocol/activity-view';
import type { LiveTurn } from './types';

/** The clock running again after an approval: the pause added up. */
export function resumed(live: LiveTurn): Pick<LiveTurn, 'pausedMs' | 'pausedAt'> {
  if (live.pausedAt === undefined) return {};
  return { pausedMs: resumeTurnClock(liveClock(live), Date.now()).pausedMs, pausedAt: undefined };
}

export function liveClock(live: LiveTurn): TurnClock {
  return { startedAt: live.startedAt, pausedMs: live.pausedMs ?? 0, ...(live.pausedAt === undefined ? {} : { pausedAt: live.pausedAt }) };
}

/** How long the running turn has taken, less approvals (turnElapsedMs, the
 * terminal's clock). */
export function liveElapsedMs(live: LiveTurn, now: number): number {
  return turnElapsedMs(liveClock(live), now);
}

/** Whether a running turn has stalled, by how long it has been quiet: the
 * yellow of the waiting line's spinner, and a conversation row's `stalled`
 * in the terminal and in VS Code. The threshold is Claude Code's three
 * minutes. Chalk free. */

export type TurnPace = 'flowing' | 'slowing' | 'stuck';

const SLOWING_AFTER_MS = 3 * 60_000;
const STUCK_AFTER_MS = 15 * 60_000;

/** Quiet this long -- no word streamed, no call started -- and a turn has
 * stalled, however young it is. A long turn that is still moving has not. */
export function turnStalled(quietMs: number): boolean {
  return quietMs >= SLOWING_AFTER_MS;
}

/** How long since the running turn last did anything -- streamed a word or
 * started a call. A long turn that is still moving is flowing; one that has
 * said nothing for fifteen minutes is stuck, however young it is. */
export function turnPace(lastActivityAt: string, now: number): TurnPace {
  const quiet = now - Date.parse(lastActivityAt);
  if (!turnStalled(quiet)) return 'flowing';
  return quiet < STUCK_AFTER_MS ? 'slowing' : 'stuck';
}

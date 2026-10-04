/** How a running turn is going, by how long it has been quiet: the colour of
 * its dot in the terminal's conversation list and in VS Code's. The
 * thresholds are Claude Code's: three minutes, fifteen. Chalk free. */

export type TurnPace = 'flowing' | 'slowing' | 'stuck';

const SLOWING_AFTER_MS = 3 * 60_000;
const STUCK_AFTER_MS = 15 * 60_000;

/** How long since the running turn last did anything -- streamed a word or
 * started a call. A long turn that is still moving is flowing; one that has
 * said nothing for fifteen minutes is stuck, however young it is. */
export function turnPace(lastActivityAt: string, now: number): TurnPace {
  const quiet = now - Date.parse(lastActivityAt);
  if (!(quiet >= SLOWING_AFTER_MS)) return 'flowing';
  return quiet < STUCK_AFTER_MS ? 'slowing' : 'stuck';
}

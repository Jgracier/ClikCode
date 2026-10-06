/** Whether a running turn has stalled, by how long it has been quiet: the
 * yellow of the waiting line's spinner, and a conversation row's `stalled`
 * in the terminal and in VS Code. The threshold is Claude Code's three
 * minutes. Chalk free. */

const STALLED_AFTER_MS = 3 * 60_000;

/** Quiet this long -- no word streamed, no call started -- and a turn has
 * stalled, however young it is. A long turn that is still moving has not. */
export function turnStalled(quietMs: number): boolean {
  return quietMs >= STALLED_AFTER_MS;
}

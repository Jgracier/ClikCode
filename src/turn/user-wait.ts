/** How long the running turn has waited on the user -- an approval, a
 * sign-in -- per conversation, in the process running it (the worker). The
 * turn's stored closing line ("Worked for 12s") counts without it, as the
 * terminal's band and VS Code's working line stop their clocks for it: the
 * two surfaces used to disagree once a turn was reopened. */

const clocks = new Map<string, { waitedMs: number; since?: number }>();

/** A turn begins: nothing waited yet. */
export function resetUserWait(sessionId: string): void {
  clocks.delete(sessionId);
}

/** Whether anything is waiting on the user now (approvals or sign-ins open). */
export function setUserWaiting(sessionId: string, waiting: boolean, now = Date.now()): void {
  const clock = clocks.get(sessionId) ?? { waitedMs: 0 };
  if (waiting && clock.since === undefined) clock.since = now;
  if (!waiting && clock.since !== undefined) {
    clock.waitedMs += Math.max(0, now - clock.since);
    delete clock.since;
  }
  clocks.set(sessionId, clock);
}

/** Time waited on the user this turn, up to `now` (a wait still open too). */
export function userWaitedMs(sessionId: string, now = Date.now()): number {
  const clock = clocks.get(sessionId);
  if (!clock) return 0;
  return clock.waitedMs + (clock.since === undefined ? 0 : Math.max(0, now - clock.since));
}

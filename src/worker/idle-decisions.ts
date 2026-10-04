/** What a session worker does at its idle time, and when it stops, as
 * decisions apart from the timers and processes they drive -- so each case
 * is tested on its own (session-worker.ts acts on them). */

/** At the worker's idle time: keep looking while the vendor's background
 * work runs (up to the ceiling), stop it past the ceiling, start a fresh
 * idle period the moment it has ended, or exit. */
export type IdleDecision = 'recheck' | 'stop-work' | 'fresh-idle' | 'exit';

export function idleDecision(input: { workRunning: boolean; workSince: number | undefined; now: number; ceilingMs: number }): IdleDecision {
  if (input.workRunning) return input.now - (input.workSince ?? input.now) < input.ceilingMs ? 'recheck' : 'stop-work';
  return input.workSince !== undefined ? 'fresh-idle' : 'exit';
}

/** Whether a stopping worker starts a successor for its conversation: only
 * when the model is owed something (a stopped shell, stopped vendor work)
 * and nobody chose to stop it -- a signal is someone's choice. */
export function startsSuccessor(owed: boolean, reason: string): boolean {
  return owed && reason !== 'SIGTERM' && reason !== 'SIGINT';
}

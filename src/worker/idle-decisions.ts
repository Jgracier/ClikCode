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

/** What holds a persistent vendor open past its idle time, or undefined
 * when nothing does. */
export interface VendorIdleState {
  transportOpen: boolean;
  turnRunning: boolean;
  /** A vendor background turn running or waiting to be shown. */
  backgroundTurn: boolean;
  /** Work a tool call left running in the vendor (toolCallWork), or a vendor
   * kept alive for its own background work (held-vendor.ts). */
  vendorWork: boolean;
  /** Approvals and sign-ins waiting on the user. */
  pendingRequests: number;
  idleForMs: number;
  closeAfterMs: number;
}

/** At the vendor's idle time: close it, look again later (something is
 * still using it, or not all the time has passed), or nothing to do (no
 * vendor open, or a turn runs -- whose end starts the clock again). Never
 * closes under work: that would stop it, and liveness is only ever derived
 * from what is really running. */
export type VendorIdleDecision = 'close' | 'later' | 'none';

export function vendorIdleDecision(input: VendorIdleState): VendorIdleDecision {
  if (!input.transportOpen || input.turnRunning) return 'none';
  if (input.idleForMs < input.closeAfterMs) return 'later';
  if (input.backgroundTurn || input.vendorWork || input.pendingRequests > 0) return 'later';
  return 'close';
}

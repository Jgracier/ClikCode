/** A browser call the user stopped. Thrown between steps and out of long waits, so the work ends instead of driving the tab on. */
export class StoppedError extends Error {
  constructor() { super('Stopped.'); this.name = 'StoppedError'; }
}

/** Throws when `signal` has aborted. */
export function throwIfStopped(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StoppedError();
}

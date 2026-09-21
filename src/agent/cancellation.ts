/** Cancelling a turn is an outcome, not a failure -- one error code, checked
 * in one place. */



export const TURN_CANCELLED_CODE = 'ERR_TURN_CANCELLED';

export function turnCancelledError(): Error & { code: string } {
  return Object.assign(new Error('Stopped'), { code: TURN_CANCELLED_CODE });
}

export function isTurnCancelled(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === TURN_CANCELLED_CODE;
}

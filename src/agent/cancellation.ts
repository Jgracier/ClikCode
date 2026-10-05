/** Cancelling a turn is an outcome, not a failure -- one error code, checked
 * in one place. */

const TURN_CANCELLED_CODE = 'ERR_TURN_CANCELLED';

export function turnCancelledError(): Error & { code: string } {
  return Object.assign(new Error('Stopped'), { code: TURN_CANCELLED_CODE });
}

/** Also an AbortError: every abortable call a turn makes (fetch, an MCP
 * request) is handed the turn's own signal, or a timeout its caller turns
 * into its own message first, so an AbortError reaching a turn is that turn
 * being stopped. */
export function isTurnCancelled(error: unknown): boolean {
  const candidate = error as { code?: unknown; name?: unknown } | null;
  return candidate?.code === TURN_CANCELLED_CODE || candidate?.name === 'AbortError';
}

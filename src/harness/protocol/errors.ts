/**
 * How a failure is put to a person, on every surface: what could not be done,
 * then why -- `Could not copy: permission denied`. Chalk free and dependency
 * free, so the webview bundle can import it. (The CLI's own command errors go
 * through src/cli/errors/message.ts, which explains network failures.)
 */

/** An error's own message, or the thrown value as text. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `Could not open a.ts: no such file`, or `Could not open a.ts.` with no
 * cause to give. `subject` is what was being done, starting with its verb. */
export function userError(subject: string, cause?: unknown): string {
  const why = cause === undefined || cause === null ? '' : errorText(cause).trim().replace(/\.$/, '');
  return why ? `Could not ${subject}: ${why}` : `Could not ${subject}.`;
}

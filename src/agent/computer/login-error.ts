/** A sign-in problem whose message is safe to show anyone: it says what
 * happened, never what the page said or what was typed. Any other error
 * (a browser timeout, a stack trace) is reported only as a generic failure. */
export class LoginError extends Error {}

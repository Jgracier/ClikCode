/** Turns ClikCode itself queues for the model (kind 'notification'): a
 * background shell's exit, vendor work a stopped worker ended. They run as
 * the user's turn -- the model must read them as input -- but the user did
 * not write them, so every window draws them as a muted ClikCode notice,
 * never as the user's own message.
 *
 * Known by their text, not a flag: once delivered they are a user message in
 * the transcript, and a native vendor's own session file (which the
 * transcript is re-read from) keeps nothing but the text. Both producers
 * below begin with a bracketed tag no person types. */

/** What every notice ClikCode writes itself begins with. */
export const CLIKCODE_NOTICE_TAG = '[ClikCode] ';
/** formatShellNotifications (agent/session-state.ts): `[background shell <id> exited ...] <command>`. */
const SHELL_NOTICE = /^\[background shell \S+ (?:exited|was stopped)/;

export function isClikCodeNotice(text: string): boolean {
  return text.startsWith(CLIKCODE_NOTICE_TAG) || SHELL_NOTICE.test(text);
}

/** The notice as shown: without the tag the row's label already says. */
export function clikCodeNoticeBody(text: string): string {
  return text.startsWith(CLIKCODE_NOTICE_TAG) ? text.slice(CLIKCODE_NOTICE_TAG.length) : text;
}

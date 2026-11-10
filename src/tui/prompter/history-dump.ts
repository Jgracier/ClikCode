/** The conversation, written into the normal screen when the alternate screen is left (see restore.ts historyDump). */
import type { TerminalHarnessPrompter } from '../prompter.js';

/** The most rows one dump writes. A client's scrollback is a few thousand rows at most, and a dump goes over the link the session is on. */
export const HISTORY_DUMP_ROWS = 2000;

/** What a row is closed with: attributes reset (a row may end inside a colour), then the line break. */
const ROW_END = '\u001b[0m\r\n';

/** The retired rows not yet written into the normal screen, as text, and the record that they were. Called at exit, at a suspend, and
 * from a crash handler, so the second call writes only what the first did not: rows are numbered for good (alternateTrimmed + index) and
 * `dumpedThrough` is the first number not written. A rewrite of the conversation (a new width, /clear, another conversation) starts
 * the count again: what is now on the screen is another text, and the earlier one stays in the client's scrollback as it was.
 * Rows keep the width they were drawn for; a client at a narrower width wraps a long one, and nothing is cut. */
export function takeHistoryDump(this: TerminalHarnessPrompter): string {
  const trimmed = this.alternateTrimmed;
  const all = [...this.alternateTranscript, ...this.pendingFinished];
  const from = this.dumpedThrough === undefined ? 0 : Math.max(0, this.dumpedThrough - trimmed);
  this.dumpedThrough = trimmed + all.length;
  const fresh = all.slice(from);
  if (!fresh.length) return '';
  const shown = fresh.slice(-HISTORY_DUMP_ROWS);
  const cut = fresh.length - shown.length;
  const note = cut > 0 ? [`\u001b[2m… ${cut} earlier row${cut === 1 ? '' : 's'} not shown; /resume reopens the whole conversation\u001b[0m`] : [];
  return `\u001b[?7h${[...note, ...shown].map((row) => `${row}${ROW_END}`).join('')}`;
}

/** The conversation, written into the normal screen when the alternate screen is left (see restore.ts historyDump). */
import type { TerminalHarnessPrompter } from '../prompter.js';

/** The most rows one dump writes. A client's scrollback is a few thousand rows at most, and a dump goes over the link the session is on. */
export const HISTORY_DUMP_ROWS = 2000;

/** What a row is closed with: attributes reset (a row may end inside a colour), then the line break. */
const ROW_END = '\u001b[0m\r\n';

/** The absolute row a dump carries on from after a rewrite: just past the message it had reached, or the start of what is kept when
 * that message is older than the window the rewrite wrote. The last message may wrap to another number of rows; the rows it had
 * written are counted as they were, clamped to its new length. */
function resumeFrom(p: TerminalHarnessPrompter, resume: NonNullable<TerminalHarnessPrompter['dumpResume']>, end: number): number {
  const start = p.messageLines.get(resume.message);
  if (start === undefined) {
    let first = Number.POSITIVE_INFINITY;
    for (const index of p.messageLines.keys()) first = Math.min(first, index);
    return resume.message < first ? 0 : end;
  }
  const next = p.messageLines.get(resume.message + 1);
  return start + Math.min(resume.into, (next ?? end) - start);
}

/** The retired rows not yet written into the normal screen, as text, and the record that they were. Called at exit, at a suspend, and
 * from a crash handler, so the second call writes only what the first did not: rows are numbered for good (alternateTrimmed + index) and
 * `dumpedThrough` is the first number not written. A rewrite of the conversation (a new width, /clear, another conversation) starts
 * the count again: what is now on the screen is another text, and the earlier one stays in the client's scrollback as it was.
 * Rows keep the width they were drawn for; a client at a narrower width wraps a long one, and nothing is cut. */
export function takeHistoryDump(this: TerminalHarnessPrompter): string {
  const trimmed = this.alternateTrimmed;
  const all = [...this.alternateTranscript, ...this.pendingFinished];
  let from = this.dumpedThrough === undefined ? 0 : Math.max(0, this.dumpedThrough - trimmed);
  // The conversation was written again (a new width): carry on after the message the dump had reached. Another conversation, or
  // one with fewer messages than that, is another text and is written whole.
  const resume = this.dumpResume;
  if (this.dumpedThrough === undefined && resume) {
    this.dumpResume = undefined;
    if (resume.session === this.currentSession?.id) from = resumeFrom(this, resume, trimmed + all.length) - trimmed;
  }
  this.dumpedThrough = trimmed + all.length;
  const fresh = all.slice(from);
  if (!fresh.length) return '';
  const shown = fresh.slice(-HISTORY_DUMP_ROWS);
  const cut = fresh.length - shown.length;
  const note = cut > 0 ? [`\u001b[2m… ${cut} earlier row${cut === 1 ? '' : 's'} not shown; /resume reopens the whole conversation\u001b[0m`] : [];
  return `\u001b[?7h${[...note, ...shown].map((row) => `${row}${ROW_END}`).join('')}`;
}

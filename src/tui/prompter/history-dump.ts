/** The conversation, written into the normal screen when the alternate screen is left (see restore.ts historyDump). */
import type { TerminalHarnessPrompter } from '../prompter.js';
import { estimatedRows } from '../render/reseed-window.js';
import { renderChunk } from './history-window.js';

/** The most rows one dump writes: 20000, about 1.5-2 MB of text. A conversation that renders to no more than this is written whole; a
 * longer one is written from its last 20000 rows, after a line that says how many earlier rows are not there. What bounds it is the
 * link the session is on (a phone, over SSH) and the client's own scrollback, not anything held here: the rows are rendered from the
 * persisted messages as the dump is made. */
export const HISTORY_DUMP_ROWS = 20000;

/** What a row is closed with: attributes reset (a row may end inside a colour), then the line break. */
const ROW_END = '\u001b[0m\r\n';

/** Messages rendered together while the dump is built from its end. */
const DUMP_BATCH = 64;

/** The note that says how many earlier rows the dump left out. */
export function earlierRowsNote(count: number): string {
  return `\u001b[2m… ${count} earlier row${count === 1 ? '' : 's'} not shown; /resume reopens the whole conversation\u001b[0m`;
}

/** Rows of the dump as one string, each closed with a reset and a line break, autowrap on first. */
function dumpText(rows: readonly string[], note: readonly string[]): string {
  return rows.length ? `\u001b[?7h${[...note, ...rows].map((row) => `${row}${ROW_END}`).join('')}` : '';
}

/** What of the conversation has not been written into the normal screen, as text, and the record that it was. Called at exit, at a
 * suspend, and from a crash handler, so the second call writes only what the first did not.
 *
 * The place is a message index (`dumpCursor`): messages before it are written; `into` rows of the one at it (an answer that was
 * still streaming, then). Rows are rendered from the persisted messages -- newest first, until the cap -- so the dump covers
 * the whole conversation and not just the rows the window holds; only the rows of an answer that has not been saved yet come
 * from the transcript. A rewrite of the conversation (a new width) keeps the place, and another conversation starts the dump over.
 * Rows keep the width they were drawn for; a client at a narrower width wraps a long one, and nothing is cut. */
export function takeHistoryDump(this: TerminalHarnessPrompter): string {
  const h = this.scrollWindow;
  if (!h.source) return legacyDump(this);
  const { messages } = h.source;
  const written = Math.min(messages.length, this.emitted.writtenCount());
  const session = this.currentSession?.id;
  const kept = this.dumpCursor;
  const cursor = kept && kept.session === session && kept.message <= written ? kept : { session, message: 0, into: 0 };
  // The saved messages after the cursor, newest first until the cap is reached.
  const parts: string[][] = [];
  let have = 0;
  let low = written;
  while (low > cursor.message && have < HISTORY_DUMP_ROWS) {
    const high = low;
    low = Math.max(cursor.message, low - DUMP_BATCH);
    const chunk = renderChunk(this, low, high).rows;
    parts.unshift(chunk);
    have += chunk.length;
  }
  let rows = parts.flat();
  if (low === cursor.message) rows = rows.slice(Math.min(cursor.into, rows.length));
  let cut = 0;
  if (rows.length > HISTORY_DUMP_ROWS) { cut = rows.length - HISTORY_DUMP_ROWS; rows = rows.slice(cut); }
  // The messages not rendered at all were older still; their rows are estimated.
  for (let index = cursor.message; index < low; index += 1) cut += estimatedRows(messages[index]!.content, h.source.inner);
  // The answer still streaming: its retired rows are in the transcript, past the saved messages' (not while far back: they were let go).
  const base = this.alternateTrimmed;
  const all = h.detached ? [] : [...this.alternateTranscript, ...this.pendingFinished];
  const live = all.slice(Math.max(0, h.liveFrom - base));
  const sameAnswer = cursor.message === written;
  const liveRows = live.slice(sameAnswer ? Math.min(cursor.into, live.length) : 0);
  this.dumpCursor = { session, message: written, into: live.length };
  return dumpText([...rows, ...liveRows], cut > 0 ? [earlierRowsNote(cut)] : []);
}

/** No conversation to draw from (rows were handed in directly): the retired rows, numbered for good (alternateTrimmed + index), with
 * `dumpedThrough` the first number not written. */
function legacyDump(p: TerminalHarnessPrompter): string {
  const trimmed = p.alternateTrimmed;
  const all = [...p.alternateTranscript, ...p.pendingFinished];
  const from = p.dumpedThrough === undefined ? 0 : Math.max(0, p.dumpedThrough - trimmed);
  p.dumpedThrough = trimmed + all.length;
  const fresh = all.slice(from);
  const shown = fresh.slice(-HISTORY_DUMP_ROWS);
  const cut = fresh.length - shown.length;
  return dumpText(shown, cut > 0 ? [earlierRowsNote(cut)] : []);
}

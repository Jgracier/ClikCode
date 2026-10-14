/** Writing a frame: making rows safe, coalescing, and flushing the retired and live rows to the terminal. */
import { stdout as output } from 'node:process';
import { closeOpenHyperlink } from '../render/hyperlinks.js';
import { sanitizeTerminalText } from '../render/text.js';
import { visibleSlice } from '../render/width.js';
import { terminalModes } from '../restore.js';
import { highlightWords } from '../render/search-focus.js';
import { highlightSelectionAt, scrollShift, shiftedRow } from '../render/selection.js';
import { logCursorEvent } from '../cursor-log.js';
import { redrawPreamble, takeQueuedModes } from '../modes.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { ALTERNATE_TRANSCRIPT_ROWS } from './state.js';
import { anchoredScrollback } from './group-actions.js';

/** One frame: `finished` rows are retired into the transcript, and the live
 * region below them is replaced. */
export function renderFrame(
  this: TerminalHarnessPrompter,
  finished: readonly string[], live: readonly string[], cursorRow: number, cursorColumn: number, hideCursor: boolean,
  liveTags: ReadonlyArray<string | undefined> = [],
): void {
  // Last line of defence: whatever produced a row, the only escape sequences
  // that reach the terminal are SGR colors, no row contains a control
  // character that would move the cursor out from under the live region, and
  // no row reaches the terminal's last column -- a row that fills it wraps
  // into a second one wherever DECAWM-off is not honoured, and every
  // relative motion in the frame after it is then one row out. The layout
  // above already budgets for this; clipping here means a new row builder
  // cannot reintroduce it.
  const limit = Math.max(1, (output.columns || 100) - 1);
  const safeRow = (row: string): string =>
    closeOpenHyperlink(visibleSlice(sanitizeTerminalText(row, { keepSgr: true, singleLine: true }), limit));
  // Most live rows are the same from one frame to the next (the footer, the
  // answer's settled lines), so each is made safe once while it stays.
  const known = this.safeLiveRows.limit === limit ? this.safeLiveRows.rows : new Map<string, string>();
  const rows = new Map<string, string>();
  const safeLive = live.map((row) => {
    const safe = known.get(row) ?? safeRow(row);
    rows.set(row, safe);
    return safe;
  });
  this.safeLiveRows = { limit, rows };
  // Frames that coalesce while a write drains accumulate their finished rows
  // instead of replacing them. A live row dropped here is drawn again by the
  // frame that replaces it; a retired row would simply be lost.
  this.pendingFinished.push(...finished.map(safeRow));
  this.pendingLive = { live: safeLive, cursorRow, cursorColumn, hideCursor, tags: [...liveTags] };
  if (!this.frameInFlight) this.flushFrame();
}

export function flushFrame(this: TerminalHarnessPrompter): void {
  if (this.closed || this.suspended) return;
  // A streaming answer may request a frame while the phone is still
  // changing size. Keep its durable rows, but wait for the final geometry
  // before drawing; repaintAfterResize supplies the fresh live rows.
  if (this.resizePaintTimer) return;
  const pending = this.pendingLive;
  if (!pending) return;
  this.pendingLive = undefined;
  const finished = this.pendingFinished;
  this.pendingFinished = [];
  if (finished.length) {
    this.secondLastFinishedRow = finished.length > 1 ? finished[finished.length - 2] : this.lastFinishedRow;
    this.lastFinishedRow = finished[finished.length - 1];
  }
  this.flushAlternateFrame(finished, pending);
}

/** One screen, every row at an address.
 *
 * Retired rows go into `alternateTranscript` instead of the terminal's
 * scrollback, the viewport shows its tail above the live region, and the
 * cursor is parked with an absolute jump. Nothing here counts rows the
 * terminal might count differently, so nothing here can drift. */
export function flushAlternateFrame(
  this: TerminalHarnessPrompter,
  finished: readonly string[],
  pending: { live: string[]; cursorRow: number; cursorColumn: number; hideCursor: boolean; tags?: Array<string | undefined> },
): void {
  if (finished.length) {
    this.alternateTranscript.push(...finished);
    // Someone reading stays where they are. The offset counts rows from the
    // end of the transcript, so rows arriving at that end move the window
    // forward by one per row -- the text walks out from under the reader
    // while a turn streams, which is what "scrolling slips through previous
    // messages" is. Growing the offset by the same count holds it still.
    if (this.alternateScrollback > 0) this.alternateScrollback += finished.length;
    // Trimming the front does not move the end, so it leaves the offset be.
    // Never past a /search mention being looked at: a long way back in a
    // long chat is exactly where one can be.
    const focusLine = this.mentionFocus ? this.messageLines.get(this.mentionFocus.messageIndex) : undefined;
    const excess = Math.min(this.alternateTranscript.length - ALTERNATE_TRANSCRIPT_ROWS,
      focusLine === undefined ? Number.POSITIVE_INFINITY : focusLine - this.alternateTrimmed);
    if (excess > 0) {
      this.alternateTranscript.splice(0, excess);
      this.alternateTrimmed += excess;
    }
  }
  const height = this.viewportRows();
  const live = pending.live.slice(-height);
  const above = Math.max(0, height - live.length);
  this.alternateAbove = above;
  // Scrolled back, the live region gives up its rows to the transcript:
  // looking at what went past is the whole point, and the composer is not
  // what is being read. A frame at offset zero is the conversation as it
  // happens.
  // How far back this screen can actually show, which is not how far back
  // the offset is allowed to go: `above` is the rows the transcript gets,
  // and it grows with the screen. A phone hiding its keyboard hands back a
  // third of the screen at once, so an offset that was inside the range a
  // moment ago is suddenly past its end -- and every further swipe moves a
  // number while the view stays pinned at the top, which reads as scrolling
  // having stopped working. The offset is clamped to what can be shown.
  // A toggled group's row stays on the screen row it was tapped on: the rows
  // above it are unchanged, so the view is moved to put it back there.
  const target = this.anchorTarget;
  this.anchorTarget = undefined;
  const anchored = target ? anchoredScrollback(target, { length: this.alternateTranscript.length, trimmed: this.alternateTrimmed, above }) : undefined;
  if (anchored !== undefined) this.alternateScrollback = anchored;
  this.jumpToMention(above);
  const furthest = Math.max(0, this.alternateTranscript.length - above);
  this.alternateScrollback = Math.min(this.alternateScrollback, furthest);
  const scrolled = this.alternateScrollback;
  const first = Math.max(0, this.alternateTranscript.length - above - scrolled);
  const shownTranscript = this.alternateTranscript.slice(first, this.alternateTranscript.length - scrolled);
  const shownLive = scrolled > 0 ? live.slice(0, Math.max(0, height - above)) : live;
  let rows = [...shownTranscript, ...shownLive];
  while (rows.length < height) rows.unshift('');
  this.frameLayout = { live: [...live], tags: (pending.tags ?? []).slice(-height) };
  if (this.mentionFocus?.words.length) {
    const words = this.mentionFocus.words;
    const transcriptRows = rows.length - shownLive.length;
    rows = rows.map((row, index) => (index < transcriptRows ? highlightWords(row, words) : row));
  }
  if (this.selection) rows = highlightSelectionAt(rows, rows.map((_, row) => this.lineAtScreenRow(row)), this.selection);
  // Only what changed. A keystroke changes the composer's row and nothing
  // else, and rewriting the whole screen for it costs kilobytes per key on
  // a phone link -- long enough for a client's own prediction popup to
  // appear in the gap before the echo lands. Each row is addressed, so a
  // partial update is exactly as safe as a whole one, which is the point of
  // drawing here. `EL` per row: replaced, never overprinted.
  const full = this.alternatePrevious.length !== rows.length;
  // A scroll is a shift, and the terminal can do a shift itself.
  //
  // Row by row, a scroll changes every row on screen, so the diff below
  // rewrites the whole thing: about 3.3KB at 63 rows against 1.6KB at 32 --
  // and 63 rows is the keyboard-hidden height, the one case that never
  // worked. The same UI drawing ~0.8KB frames receives the gesture at both
  // heights. Cost per frame is the difference, and it scales with the screen.
  //
  // So when the new screen is the old one shifted -- which is exactly what a
  // scroll produces -- the shift is handed to the terminal (SU/SD inside a
  // region covering the transcript) and only the rows it exposed are drawn.
  // Three rows instead of sixty-three.
  //
  // Claude Code never rewrites whole rows either: 4,182 relative motions in
  // one captured session against 347 absolute jumps. This UI had zero.
  // Only a transcript scroll hands the movement to the terminal. Other
  // screens that happen to look shifted -- a palette opening, a picker
  // closing -- are drawn, because SU inside a region discards what it pushes
  // out and those are not rows this code can redraw from its own transcript.
  const scrolling = this.paintingScroll;
  this.paintingScroll = false;
  const shift = full || !scrolling ? 0 : scrollShift(this.alternatePrevious, rows, above);
  const updates: string[] = [];
  // Rows the shift already drew, so the diff below does not draw them twice
  // -- a frame carrying the same row twice is a duplicated prompt on screen.
  let exposedFrom = -1;
  let exposedTo = -1;
  if (shift !== 0) {
    const span = Math.abs(shift);
    // Region over the transcript only, so the live region stays put; reset
    // straight after, because a region left set confines every later frame.
    updates.push(`\u001b[1;${above}r`);
    updates.push(shift > 0 ? `\u001b[${span}S` : `\u001b[${span}T`);
    updates.push('\u001b[r');
    const exposed = shift > 0 ? rows.slice(above - span, above) : rows.slice(0, span);
    exposedFrom = shift > 0 ? above - span : 0;
    exposedTo = exposedFrom + span;
    for (const [offset, row] of exposed.entries()) {
      updates.push(`\u001b[${exposedFrom + offset + 1};1H${row}\u001b[K`);
    }
  }
  for (const [index, row] of rows.entries()) {
    if (!full && this.alternatePrevious[index] === row) continue;
    if (index >= exposedFrom && index < exposedTo) continue;
    if (shift !== 0 && index < above && shiftedRow(this.alternatePrevious, index, shift) === row) continue;
    updates.push(`\u001b[${index + 1};1H${row}\u001b[K`);
  }
  this.alternatePrevious = rows;
  const composerRow = rows.length - live.length + pending.cursorRow + 1;
  // Parked whether or not the cursor is shown. DECTCEM is a request, and a
  // client that draws its own caret regardless (phone clients do) puts it
  // wherever this code last left it -- which, unparked, is the end of the
  // block's last row: the status line, under the composer. Only the `?25h`
  // below depends on whether the frame shows it.
  const park = `\u001b[${Math.max(1, Math.min(height, composerRow))};${Math.max(1, pending.cursorColumn)}H`;
  const modes = takeQueuedModes();
  const signals = this.pendingSignals;
  this.pendingSignals = '';
  const showCursor = !pending.hideCursor;
  // Nothing changed: nothing is written. A clock that ticks every second
  // used to send a cursor hide, a park and a show each time regardless.
  if (!updates.length && !modes && !signals && park === this.lastPark && showCursor === this.cursorShown) return;
  // The preamble goes with rows, never alone: a clear with nothing after
  // it would only blank the screen, so a resize or repair waits for them.
  const draw = updates.length ? `${redrawPreamble(this.provisionalFrame ? undefined : this.pendingRedraw)}${updates.join('')}` : '';
  if (updates.length && !this.provisionalFrame) this.pendingRedraw = undefined;
  const cursor = showCursor && (updates.length || !this.cursorShown) ? '\u001b[?25h'
    : !showCursor && !updates.length && this.cursorShown !== false ? '\u001b[?25l' : '';
  // One synchronized update (DEC 2026): a terminal that supports it shows
  // the frame whole or not at all, never half-drawn; one that does not
  // ignores the two sequences. restoreTerminal closes it on any exit.
  const frame = `\u001b[?2026h${modes}${signals}${draw}${park}${cursor}\u001b[?2026l`;
  this.lastPark = park;
  this.cursorShown = showCursor;
  this.frameInFlight = true;
  terminalModes.painted = true;
  logCursorEvent(`alternate frame: height=${height} rows=${updates.length}/${rows.length} composer=${composerRow} col=${pending.cursorColumn}`);
  output.write(frame, () => {
    this.frameInFlight = false;
    if (this.pendingLive && !this.closed && !this.suspended) this.flushFrame();
  });
}

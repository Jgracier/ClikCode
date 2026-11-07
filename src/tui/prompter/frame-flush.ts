/** Writing a frame: making rows safe, coalescing, and flushing the retired and live rows to the terminal. */
import { stdout as output } from 'node:process';
import { closeOpenHyperlink } from '../render/hyperlinks.js';
import { sanitizeTerminalText } from '../render/text.js';
import { visibleSlice } from '../render/width.js';
import { terminalModes } from '../restore.js';
import { highlightWords } from '../render/search-focus.js';
import { highlightSelectionAt, scrollShift, shiftedRow } from '../render/selection.js';
import { logCursorEvent } from '../cursor-log.js';
import { eraseInlineBlock, inlineBlock, inlineHistoryMode, CLEAR_SCREEN_AND_SCROLLBACK } from '../inline.js';
import { asciiMode, foldAscii } from '../glyphs.js';
import { syncBegin, syncEnd } from '../probe.js';
import { redrawPreamble, takeQueuedModes } from '../modes.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { ALTERNATE_TRANSCRIPT_ROWS } from './state.js';
import { anchoredScrollback } from './group-actions.js';

/** A row as the terminal may be given it: only SGR escapes, one line, no hyperlink left open, and
 * never the last column. The one place a row is made safe. */
function safeRow(row: string, limit: number): string {
  const clean = sanitizeTerminalText(row, { keepSgr: true, singleLine: true });
  return closeOpenHyperlink(visibleSlice(asciiMode() ? foldAscii(clean) : clean, limit));
}

/** One frame: `finished` rows are retired into the transcript, and the live
 * region below them is replaced. */
export function renderFrame(
  this: TerminalHarnessPrompter,
  finished: readonly string[], live: readonly string[], cursorRow: number, cursorColumn: number, hideCursor: boolean,
  liveTags: ReadonlyArray<string | undefined> = [],
  tail?: { rows: readonly string[]; tags: ReadonlyArray<string | undefined> },
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
  // Most live rows are the same from one frame to the next (the footer, the
  // answer's settled lines), so each is made safe once while it stays.
  const known = this.safeLiveRows.limit === limit ? this.safeLiveRows.rows : new Map<string, string>();
  const rows = new Map<string, string>();
  const safeLive = live.map((row) => {
    const safe = known.get(row) ?? safeRow(row, limit);
    rows.set(row, safe);
    return safe;
  });
  this.safeLiveRows = { limit, rows };
  // Frames that coalesce while a write drains accumulate their finished rows
  // instead of replacing them. A live row dropped here is drawn again by the
  // frame that replaces it; a retired row would simply be lost.
  this.pendingFinished.push(...finished.map((row) => safeRow(row, limit)));
  this.pendingLive = {
    live: safeLive, cursorRow, cursorColumn, hideCursor, tags: [...liveTags],
    ...(tail ? { tail: { rows: tail.rows.map((row) => safeRow(row, limit)), tags: [...tail.tags] } } : {}),
  };
  if (!this.frameInFlight) this.flushFrame();
}

export function flushFrame(this: TerminalHarnessPrompter): void {
  if (this.closed || this.suspended || inlineBlock.measuring) return;
  const pending = this.pendingLive;
  if (!pending) return;
  this.pendingLive = undefined;
  const finished = this.pendingFinished;
  this.pendingFinished = [];
  if (finished.length) {
    this.secondLastFinishedRow = finished.length > 1 ? finished[finished.length - 2] : this.lastFinishedRow;
    this.lastFinishedRow = finished[finished.length - 1];
  }
  if (inlineHistoryMode()) { this.flushInlineFrame(finished, pending); return; }
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
  pending: { live: string[]; cursorRow: number; cursorColumn: number; hideCursor: boolean; tags?: Array<string | undefined>; tail?: { rows: string[]; tags: Array<string | undefined> } },
): void {
  if (pending.tail) this.scrollTail = pending.tail;
  const lastBody = this.scrollBodyLength;
  const trimmedBefore = this.alternateTrimmed;
  if (finished.length) {
    this.alternateTranscript.push(...finished);
    // Someone reading stays where they are. The offset counts rows from the
    // end of the transcript, so rows arriving at that end move the window
    // forward by one per row -- the text walks out from under the reader
    // while a turn streams, which is what "scrolling slips through previous
    // messages" is. Growing the offset by the same count holds it still.
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
  // Held still while rows arrive at the end of what can be read: the
  // transcript's new rows, and the live conversation growing or retiring.
  const extra = this.viewExtra;
  if (this.alternateScrollback > 0 && lastBody !== undefined) {
    this.alternateScrollback = Math.max(0, this.alternateScrollback + this.alternateTranscript.length + extra.rows.length - lastBody + (this.alternateTrimmed - trimmedBefore));
  }
  const height = this.viewportRows();
  const live = pending.live.slice(-height);
  const above = Math.max(0, height - live.length);
  // Where the boundary was: scrolling back gives the history the rows the live conversation had, and
  // leaving it takes them back, so the boundary moves in the frame the scroll begins and ends.
  const aboveBefore = this.alternateAbove;
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
  const bodyLength = this.alternateTranscript.length + extra.rows.length;
  const anchored = target ? anchoredScrollback(target, { length: bodyLength, trimmed: this.alternateTrimmed, above }) : undefined;
  if (anchored !== undefined) this.alternateScrollback = anchored;
  this.jumpToMention(above);
  const furthest = Math.max(0, bodyLength - above);
  this.alternateScrollback = Math.min(this.alternateScrollback, furthest);
  const scrolled = this.alternateScrollback;
  this.scrollBodyLength = scrolled > 0 ? bodyLength : undefined;
  const first = Math.max(0, bodyLength - above - scrolled);
  const transcriptLength = this.alternateTranscript.length;
  const shownTranscript = [
    ...this.alternateTranscript.slice(first, Math.min(transcriptLength, bodyLength - scrolled)),
    // The end never below zero: a negative one counts from the end of the rows, and gave the first
    // step back (an offset past the live tail's length) one row too many.
    ...(scrolled > 0 ? extra.rows.slice(Math.max(0, first - transcriptLength), Math.max(0, bodyLength - scrolled - transcriptLength)) : []),
  ];
  const shownLive = scrolled > 0 ? live.slice(0, Math.max(0, height - above)) : live;
  let rows = [...shownTranscript, ...shownLive];
  while (rows.length < height) rows.unshift('');
  // Never taller than the screen, by construction: the live rows are at most `height` and the history
  // gets exactly the rows they leave (`above`), so there is nothing to cut.
  this.frameLayout = { live: [...live], tags: (pending.tags ?? []).slice(-height) };
  if (this.mentionFocus?.words.length) {
    const words = this.mentionFocus.words;
    const transcriptRows = rows.length - shownLive.length;
    rows = rows.map((row, index) => (index < transcriptRows ? highlightWords(row, words) : row));
  }
  if (this.selection) rows = highlightSelectionAt(rows, rows.map((_, row) => this.lineAtScreenRow(row)), this.selection);
  // An open list covers the rows just above the footer and nothing else. The footer stays, so the
  // composer stays, and every chat row above the list stays on its screen row. Covering them by
  // growing the footer moved both.
  const overlay = this.pickerOverlay;
  const chrome = this.chromeRows;
  if (overlay.length && chrome > 0 && shownLive.length >= chrome) {
    const limit = Math.max(1, (output.columns || 100) - 1);
    const footerStart = rows.length - chrome;
    const at = footerStart - overlay.length;
    for (const [offset, row] of overlay.entries()) {
      const index = at + offset;
      if (index >= 0 && index < footerStart) rows[index] = safeRow(row, limit);
    }
  }
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
  // Only the rows above both boundaries are a transcript that moved; the ones between them were live
  // rows a moment ago (or are about to be) and are drawn. Taking the larger boundary found no clean shift
  // at the first step, and drew the whole history again.
  const moving = Math.min(above, aboveBefore);
  const shift = full || !scrolling ? 0 : scrollShift(this.alternatePrevious, rows, moving);
  const updates: string[] = [];
  // Rows the shift already drew, so the diff below does not draw them twice
  // -- a frame carrying the same row twice is a duplicated prompt on screen.
  let exposedFrom = -1;
  let exposedTo = -1;
  if (shift !== 0) {
    const span = Math.abs(shift);
    // Region over the transcript only, so the live region stays put; reset
    // straight after, because a region left set confines every later frame.
    updates.push(`\u001b[1;${moving}r`);
    updates.push(shift > 0 ? `\u001b[${span}S` : `\u001b[${span}T`);
    updates.push('\u001b[r');
    const exposed = shift > 0 ? rows.slice(moving - span, moving) : rows.slice(0, span);
    exposedFrom = shift > 0 ? moving - span : 0;
    exposedTo = exposedFrom + span;
    for (const [offset, row] of exposed.entries()) {
      updates.push(`\u001b[${exposedFrom + offset + 1};1H${row}\u001b[K`);
    }
  }
  for (const [index, row] of rows.entries()) {
    if (!full && this.alternatePrevious[index] === row) continue;
    if (index >= exposedFrom && index < exposedTo) continue;
    if (shift !== 0 && index < moving && shiftedRow(this.alternatePrevious, index, shift) === row) continue;
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
  // While a resize burst is still settling a frame (a keystroke's echo, a
  // streaming row) is an ordinary diff; the clear and the mouse modes go with
  // the one settled repaint, so the screen is blanked once per burst.
  const redraw = this.resizePaintTimer && this.pendingRedraw === 'resize' ? undefined : this.pendingRedraw;
  const draw = updates.length ? `${redrawPreamble(redraw)}${updates.join('')}` : '';
  if (updates.length && redraw === this.pendingRedraw) this.pendingRedraw = undefined;
  // The caret changes state only when it has to: hidden by a clear (so shown
  // again after it), by a list that asks for it, or never shown yet. A
  // frame that merely moves rows under a visible caret does not touch it.
  const visibleBefore = updates.length > 0 && redraw !== undefined ? false : this.cursorShown;
  const hideFirst = !showCursor && visibleBefore !== false ? '\u001b[?25l' : '';
  const cursor = showCursor && visibleBefore !== true ? '\u001b[?25h' : '';
  // One synchronized update (DEC 2026): a terminal that supports it shows
  // the frame whole or not at all, never half-drawn; one that does not
  // ignores the two sequences. restoreTerminal closes it on any exit.
  const frame = `${syncBegin()}${modes}${signals}${hideFirst}${draw}${park}${cursor}${syncEnd()}`;
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

/** Append-only frame for inline-history mode. Finished rows are printed once,
 * above the block, and become the terminal's own scrollback; the block
 * (composer, status, any open list) is erased and redrawn with relative motion
 * only, so a resize or a keyboard change cannot leave it anywhere the next
 * frame cannot find. */
export function flushInlineFrame(
  this: TerminalHarnessPrompter,
  finished: readonly string[],
  pending: { live: string[]; cursorRow: number; cursorColumn: number; hideCursor: boolean },
): void {
  // Line numbers for the rows kept, as the alternate frame does; nothing is drawn from them.
  if (finished.length) {
    this.alternateTranscript.push(...finished);
    const excess = this.alternateTranscript.length - ALTERNATE_TRANSCRIPT_ROWS;
    if (excess > 0) { this.alternateTranscript.splice(0, excess); this.alternateTrimmed += excess; }
  }
  const height = this.viewportRows();
  let live = pending.live;
  let cursorRow = pending.cursorRow;
  // An open list covers the rows just above the footer: in this mode it is
  // part of the block, which grows for it and shrinks when it closes.
  const overlay = this.pickerOverlay;
  const chrome = this.chromeRows;
  if (overlay.length && chrome > 0 && live.length >= chrome) {
    const limit = Math.max(1, (output.columns || 100) - 1);
    const at = live.length - chrome;
    live = [...live.slice(0, at), ...overlay.map((row) => safeRow(row, limit)), ...live.slice(at)];
    if (cursorRow >= at) cursorRow += overlay.length;
  }
  const clear = inlineBlock.clearNext;
  inlineBlock.clearNext = false;
  // THE ANCHORING RULE. The block ends on the last row of the screen, and everything above it is the conversation, in
  // order, with no row of it ever blank, repeated or lost. Two things change the rows available to the conversation:
  //  - the block itself growing or shrinking. Growing scrolls the top row into the terminal's scrollback (or, while the
  //    conversation is shorter than the screen, deletes a blank row above it: `pad`). Shrinking cannot pull a row back
  //    out of the scrollback, so the block keeps its height: the rows it no longer needs stay blank at its top (the
  //    spacer) until a retired row or a growing block uses them. History is never moved, never given blank rows.
  //  - the terminal changing height. What a terminal does with its own screen then (pull saved lines back, add blank rows
  //    at the bottom, drop the rows below the cursor, push the top rows into the saved lines) differs from one to the
  //    next, so it is asked, not assumed: `found` is the row its cursor report puts the block's first row on. The block
  //    alone is erased and drawn again, to end on the last row. A conversation is never written for a change of height
  //    (a change of width is the one that does: rows are wrapped for a width, see rewrapIfWidthChanged). Rows the block
  //    now stands too low for are made by delete-lines at the top (the blank rows above a short conversation go first,
  //    so none is scrolled into the saved lines); rows it stands too high for are made by insert-lines there, when the
  //    saved lines hold nothing of the conversation. When they do, nothing can give the screen those rows back (a
  //    terminal that does not pull them in itself has left blank rows below the block), and a blank row opened above
  //    them would go into the saved lines at the next shrink: the block stays as high as those rows allow (`slack`)
  //    until output fills them.
  const anchored = !clear && inlineBlock.rows > 0;
  const found = anchored ? inlineBlock.found : undefined;
  inlineBlock.found = undefined;
  // Rows the terminal pushed into the saved lines (positive) or pulled back out of them (negative): the top of the screen
  // goes first, and the top of the screen is the blank rows above a short conversation.
  const moved = found === undefined ? 0 : inlineBlock.height - inlineBlock.rows - inlineBlock.slack - found;
  const blanksOnly = moved > 0 && moved <= inlineBlock.pad;
  // Whether the saved lines hold nothing of the conversation: a conversation shorter than the screen has blank rows above
  // it, and a terminal that pulled saved lines back and still has room left had no more to pull.
  const onScreen = inlineBlock.pad > 0 || moved < 0;
  if (anchored) {
    const spacer = Math.max(0, inlineBlock.rows - finished.length - live.length);
    if (spacer) {
      live = [...Array<string>(spacer).fill(''), ...live];
      cursorRow += spacer;
    }
  }
  // A block taller than the screen would make the walk back up clamp at the top edge.
  if (live.length > height) {
    cursorRow -= live.length - height;
    live = live.slice(-height);
  }
  const lastRow = Math.max(0, live.length - 1);
  cursorRow = Math.max(0, Math.min(cursorRow, lastRow));
  this.frameLayout = { live: [...live], tags: (pending as { tags?: Array<string | undefined> }).tags?.slice(-height) ?? [] };
  const showCursor = !pending.hideCursor;
  const signature = JSON.stringify([live, cursorRow, pending.cursorColumn, showCursor]);
  const modes = takeQueuedModes();
  const signals = this.pendingSignals;
  this.pendingSignals = '';
  const lost = anchored && inlineBlock.lost;
  inlineBlock.lost = false;
  if (!clear && !lost && !finished.length && !modes && !signals && signature === inlineBlock.last) {
    if (found === undefined) return;
    // The terminal left the block where it belongs, or as high as the blank rows it added below allow: nothing to write.
    const gap = height - found - inlineBlock.rows;
    if (!blanksOnly && (gap === 0 || (gap > 0 && !onScreen))) {
      inlineBlock.height = height;
      inlineBlock.slack = Math.max(0, gap);
      inlineBlock.pad = Math.max(0, inlineBlock.pad - Math.max(0, moved));
      return;
    }
  }
  const previous = inlineBlock.liveRows;
  const columns = output.columns || 100;
  // Unchanged rows are never sent again: with the block already drawn, at the same width, and
  // nothing retired above it, only the rows that differ are rewritten, reached by relative motion.
  const diff = anchored && !lost && found === undefined && !finished.length && previous.length === inlineBlock.rows && inlineBlock.columns === columns;
  let lead = '';
  let text = '';
  let park: string;
  let nextPad = Math.max(0, inlineBlock.pad - Math.max(0, moved));
  let nextSlack = 0;
  if (diff) {
    let at = inlineBlock.cursorRow;
    const move = (to: number): string => {
      const step = to - at;
      at = to;
      return step < 0 ? `\u001b[${-step}A` : step > 0 ? `\u001b[${step}B` : '';
    };
    if (live.length > previous.length && nextPad > 0) {
      // Growing from the bottom edge: pull the blank rows above the conversation out first,
      // so nothing blank scrolls into the saved lines. The cursor ends on the block's new top.
      const top = height - previous.length - inlineBlock.slack;
      const take = Math.min(live.length - previous.length, nextPad);
      text += `${top + at > 0 ? `\u001b[${top + at}A` : ''}\u001b[${take}M`;
      at = -(top - take);
      nextPad -= take;
    }
    const common = Math.min(previous.length, live.length);
    for (let index = 0; index < common; index += 1) {
      if (previous[index] !== live[index]) text += `${move(index)}\r${live[index]}\u001b[K`;
    }
    if (live.length > previous.length) {
      // New rows below: the newline scrolls the screen when the block is at its bottom edge.
      text += move(previous.length - 1);
      for (let index = previous.length; index < live.length; index += 1) text += `\r\n${live[index]}\u001b[K`;
      at = live.length - 1;
      // The new rows go into the blank rows below the block before any of them scrolls.
      nextSlack = Math.max(0, inlineBlock.slack - (live.length - previous.length));
    } else nextSlack = inlineBlock.slack;
    park = `${move(cursorRow)}\u001b[${Math.max(1, pending.cursorColumn)}G`;
  } else {
    // Lost: the terminal did not say where its cursor is after the resize, so no row is computed from a position that was
    // never learned. The block is erased from the cursor and drawn there; `pad` and `slack` are unknown, so zero.
    const oldTop = lost ? undefined : anchored ? found ?? inlineBlock.height - inlineBlock.rows - inlineBlock.slack : undefined;
    if (lost) { nextPad = 0; nextSlack = 0; }
    if (clear) { lead = CLEAR_SCREEN_AND_SCROLLBACK; inlineBlock.rows = 0; inlineBlock.cursorRow = 0; }
    else lead = eraseInlineBlock();
    const body = [...finished, ...live];
    if (clear) {
      // The one absolute move: start low enough that what is printed ends on the last row.
      nextPad = Math.max(0, height - body.length);
      if (nextPad > 0) lead += `\u001b[${nextPad + 1};1H`;
    } else if (oldTop !== undefined) {
      // The cursor is on the old block's first row. What is printed from there ends on the last row, runs past it, or
      // stops short of it.
      // Past it: every row it runs past would scroll one into the saved lines, so the blank rows above the conversation go first.
      const amount = Math.min(Math.max(0, oldTop + body.length - height), nextPad);
      if (amount > 0) {
        lead += `${oldTop > 0 ? `\u001b[${oldTop}A` : ''}\u001b[${amount}M`;
        const to = oldTop - amount;
        if (to > 0) lead += `\u001b[${to}B`;
        nextPad -= amount;
      }
      // Short of it: the terminal added blank rows below the block. If it has nothing of the conversation in the saved lines
      // the screen is pushed down by as many, and the blank rows that open at its top are the new blank rows above the
      // conversation. Otherwise the block stays where it is, as high as those rows allow, until output fills them: there
      // is no way to give the screen the saved lines back, and a blank row opened above them would be pushed into the
      // saved lines by the next shrink, one more blank band in the conversation each time the screen changes.
      const gap = height - oldTop - body.length;
      if (gap > 0 && onScreen) {
        lead += `\u001b[1;1H\u001b[${gap}L\u001b[${oldTop + gap + 1};1H`;
        nextPad += gap;
      } else if (gap > 0) nextSlack = gap;
      // Blank rows the terminal pushed into the saved lines were all it had there: none of the conversation, so they go.
      if (blanksOnly) lead += '\u001b[3J';
    }
    text = body.map((row, index) => `${row}\u001b[K${index < body.length - 1 ? '\r\n' : ''}`).join('');
    // The cursor is on the block's last row; walk up to the composer's.
    const back = lastRow - cursorRow;
    park = `${back ? `\u001b[${back}A` : ''}\u001b[${Math.max(1, pending.cursorColumn)}G`;
  }
  inlineBlock.pad = nextPad;
  inlineBlock.slack = nextSlack;
  if (!anchored || found !== undefined || lost) inlineBlock.height = height;
  inlineBlock.rows = live.length;
  inlineBlock.cursorRow = cursorRow;
  inlineBlock.last = signature;
  inlineBlock.liveRows = [...live];
  inlineBlock.columns = columns;
  this.pendingRedraw = undefined;
  this.lastPark = park;
  this.cursorShown = showCursor;
  const frame = `${syncBegin()}${modes}${signals}\u001b[?25l\u001b[?7l${lead}${text}${park}${showCursor ? '\u001b[?25h' : ''}${syncEnd()}`;
  this.frameInFlight = true;
  terminalModes.painted = true;
  logCursorEvent(`inline frame: block=${live.length} finished=${finished.length} composer=${cursorRow} col=${pending.cursorColumn}`);
  output.write(frame, () => {
    this.frameInFlight = false;
    if (this.pendingLive && !this.closed && !this.suspended) this.flushFrame();
  });
}

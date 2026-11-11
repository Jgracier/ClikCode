/** Writing a frame: making rows safe, coalescing, and flushing the retired and live rows to the terminal. */
import { stdout as output } from 'node:process';
import { closeOpenHyperlink } from '../render/hyperlinks.js';
import { sanitizeTerminalText } from '../render/text.js';
import { visibleSlice } from '../render/width.js';
import { terminalModes } from '../restore.js';
import { highlightWords } from '../render/search-focus.js';
import { highlightSelectionAt, scrollShift, shiftedRow } from '../render/selection.js';
import { logCursorEvent } from '../cursor-log.js';
import { swallowsAlternateScreen, eraseInlineBlock, inlineBlock, inlineHistoryMode, restoreMainBlock, CLEAR_SCREEN, CLEAR_SCREEN_AND_SCROLLBACK, ENTER_PAGE_SCREEN, LEAVE_PAGE_SCREEN } from '../inline.js';
import { asciiMode, foldAscii } from '../glyphs.js';
import { syncBegin, syncEnd } from '../probe.js';
import { redrawPreamble, takeQueuedModes } from '../modes.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { INLINE_TRANSCRIPT_ROWS } from './state.js';
import { settleWindow } from './history-window.js';
import { anchoredScrollback } from './group-actions.js';

/** More rows than this in one frame and the caret is hidden for it. */
export const BULK_ROWS = 8;

/** A row as the terminal may be given it: only SGR escapes, one line, no hyperlink left open, and
 * never the last column. The one place a row is made safe. */
export function safeRow(row: string, limit: number): string {
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
  if (!this.canPaint('picker') || inlineBlock.measuring) return;
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
  // Far back, the rows at the live end are not held: they are written from the list when the view comes back to it.
  if (finished.length && this.scrollWindow.detached) this.scrollWindow.gap = true;
  else if (finished.length) {
    this.alternateTranscript.push(...finished);
    // Someone reading stays where they are. The offset counts rows from the
    // end of the transcript, so rows arriving at that end move the window
    // forward by one per row -- the text walks out from under the reader
    // while a turn streams, which is what "scrolling slips through previous
    // messages" is. Growing the offset by the same count holds it still.
    // Rows past the window's front are let go (history-window.ts), which does not move the end either.
  }
  // Held still while rows arrive at the end of what can be read: the
  // transcript's new rows, and the live conversation growing or retiring.
  const extra = this.viewExtra;
  if (this.alternateScrollback > 0 && lastBody !== undefined) {
    this.alternateScrollback = Math.max(0, this.alternateScrollback + this.alternateTranscript.length + extra.rows.length + this.scrollWindow.rowsBelow - lastBody);
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
  // The rows of messages the window does not hold are made to exist around the view (a few batches, within a frame's budget),
  // and the window's far rows are let go, before anything is drawn from it.
  settleWindow(this, above);
  const body = this.viewExtra;
  const bodyLength = this.alternateTranscript.length + body.rows.length + this.scrollWindow.rowsBelow;
  const anchored = target ? anchoredScrollback(target, { length: bodyLength, trimmed: this.alternateTrimmed, above }) : undefined;
  if (anchored !== undefined) this.alternateScrollback = anchored;
  this.jumpToMention(above);
  const furthest = Math.max(0, bodyLength - above);
  // Past what is held yet: drawn at the window's edge while the next batch is rendered (another frame is owed), kept as asked.
  const shown = Math.max(Math.min(this.alternateScrollback, furthest), this.scrollWindow.rowsBelow);
  if (this.scrollWindow.first === 0 || !this.scrollWindow.more) this.alternateScrollback = Math.min(this.alternateScrollback, furthest);
  const scrolled = shown;
  this.scrollBodyLength = scrolled > 0 ? bodyLength : undefined;
  const first = Math.max(0, bodyLength - above - scrolled);
  const transcriptLength = this.alternateTranscript.length;
  const shownTranscript = [
    ...this.alternateTranscript.slice(first, Math.min(transcriptLength, bodyLength - scrolled)),
    // The end never below zero: a negative one counts from the end of the rows, and gave the first
    // step back (an offset past the live tail's length) one row too many.
    ...(scrolled > 0 ? body.rows.slice(Math.max(0, first - transcriptLength), Math.max(0, bodyLength - scrolled - transcriptLength)) : []),
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
  // Only a transcript scroll, or a frame that retires lines (the answer
  // streaming: the transcript moves up by exactly the rows retired), hands
  // the movement to the terminal. Other screens that happen to look shifted
  // -- a palette opening, a picker closing -- are drawn, because SU inside a
  // region discards what it pushes out and those are not rows this code can
  // redraw from its own transcript. For the retiring frame that is safe
  // because scrollShift only answers when every row it moves is equal in the
  // new screen, and the rows it exposes are drawn. Without it every retired
  // line rewrote ~50 of 57 rows (3.7 KB against ~0.3 KB). GNU screen (no
  // alternate screen, SU unverified) keeps the diff for streaming.
  const scrolling = this.paintingScroll || (finished.length > 0 && !swallowsAlternateScreen());
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
  let drawnRows = 0;
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
      drawnRows += 1;
    }
  }
  for (const [index, row] of rows.entries()) {
    if (!full && this.alternatePrevious[index] === row) continue;
    if (index >= exposedFrom && index < exposedTo) continue;
    if (shift !== 0 && index < moving && shiftedRow(this.alternatePrevious, index, shift) === row) continue;
    updates.push(`\u001b[${index + 1};1H${row}\u001b[K`);
    drawnRows += 1;
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
  // A frame that draws many rows hides the caret while it does (and shows it after, inside the same synchronized update): a client
  // without synchronized output (GNU screen, an older tmux) would otherwise show it hopping down the screen row by row. A few
  // rows -- a streamed line, a keystroke -- leave it alone, as above.
  const bulk = drawnRows > BULK_ROWS;
  const hideFirst = (!showCursor || bulk) && visibleBefore !== false ? '\u001b[?25l' : '';
  const cursor = showCursor && (visibleBefore !== true || hideFirst !== '') ? '\u001b[?25h' : '';
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
    if (this.pendingLive && this.canPaint('picker')) this.flushFrame();
  });
  // More history is wanted under the view than one frame's budget rendered: the next batch is another frame, so the event loop
  // is free between them (a key, a resize, the stream).
  if (this.scrollWindow.more) this.schedulePaint(0);
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
  const height = this.viewportRows();
  // A modal surface: an open list (the board, the palette, a picker) is the whole visible screen, not a block under the
  // conversation. It is drawn from the top row at output.rows; when it closes the conversation block is anchored again.
  const overlay = this.pickerOverlay;
  const chrome = this.chromeRows;
  const page = chrome > 0 && pending.live.length >= chrome && (this.surface === 'history' || overlay.length > 0);
  // Line numbers for the rows kept, as the alternate frame does; nothing is drawn from them.
  if (finished.length) {
    this.alternateTranscript.push(...finished);
    const excess = this.alternateTranscript.length - INLINE_TRANSCRIPT_ROWS;
    if (excess > 0) { this.alternateTranscript.splice(0, excess); this.alternateTrimmed += excess; }
  }
  let live = pending.live;
  let cursorRow = pending.cursorRow;
  if (page) { flushInlinePage.call(this, finished, pending, height); return; }
  if (overlay.length && chrome > 0 && live.length >= chrome) {
    const limit = Math.max(1, (output.columns || 100) - 1);
    const at = live.length - chrome;
    live = [...live.slice(0, at), ...overlay.map((row) => safeRow(row, limit)), ...live.slice(at)];
    if (cursorRow >= at) cursorRow += overlay.length;
  }
  // The surface closed: the alternate screen is left and the main screen is as it was (the conversation and its block, not
  // touched while the page was up), the block's state put back. What the conversation retired meanwhile (`tail`) is written
  // above the block, as any retired rows are. A conversation written whole meanwhile (a new width: `wipe`) clears the main
  // screen and writes it again; one written whole in THIS frame (clearNext) already has every row in `finished`.
  const dropTail = inlineBlock.clearNext;
  const leaving = inlineBlock.page;
  let leave = '';
  if (leaving) {
    const resizedWhile = inlineBlock.resized;
    if (inlineBlock.wipe) inlineBlock.clearNext = true;
    restoreMainBlock();
    inlineBlock.resized = false;
    inlineBlock.wipe = false;
    terminalModes.alternateScreen = false;
    leave = LEAVE_PAGE_SCREEN;
    if (resizedWhile && !inlineBlock.clearNext && inlineBlock.rows > 0) {
      // The main screen changed size while it was hidden, and what the terminal did with its rows is its own business: leave
      // the page, then ask where the cursor is (the resize path) and draw the block from that answer.
      inlineBlock.tail = [...inlineBlock.tail, ...finished];
      output.write(`${syncBegin()}${leave}${syncEnd()}`);
      this.anchorBlock();
      return;
    }
  }
  const carried = dropTail ? [] : inlineBlock.tail;
  inlineBlock.tail = [];
  const retired = carried.length ? [...carried, ...finished] : finished;
  const wipe = inlineBlock.clearNext;
  const clear = wipe || (leaving && inlineBlock.rows === 0);
  inlineBlock.clearNext = false;
  // WHAT THE BLOCK OWNS. This writer owns the live block (composer, status, any open list) and nothing above it: the
  // conversation is the terminal's own, written once, and never moved, padded, or given a blank row. It assumes nothing about
  // the terminal's geometry either. When the screen changes height, what the terminal does with its own rows differs from one
  // client to the next (pull saved lines back in or not, add blank rows below or not, drop the rows under the cursor), so the
  // terminal is asked where its cursor is (see anchorBlock) and the block is erased from its first row down and drawn again
  // there, by relative motion. A client that pulls keeps the composer at the bottom; one that does not shows blank rows
  // below the composer until output fills them, and the history stays directly above the block either way.
  // The one exception is the start (and a replaced conversation): the block is drawn on the last rows, with blank rows above
  // a short conversation (`pad`, at the top of the screen), which anything that would scroll the screen takes back by
  // delete-lines first, so none is pushed into the saved lines. A resize forgets them: the terminal has moved its own rows.
  const anchored = !clear && inlineBlock.rows > 0;
  const found = anchored ? inlineBlock.found : undefined;
  inlineBlock.found = undefined;
  const lost = anchored && inlineBlock.lost;
  inlineBlock.lost = false;
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
  const modes = `${leave}${takeQueuedModes()}`;
  const signals = this.pendingSignals;
  this.pendingSignals = '';
  // A change of height always redraws the block: the terminal may have dropped the rows under the cursor, and nothing says it did not.
  const resized = found !== undefined || lost;
  if (!clear && !resized && !retired.length && !modes && !signals && signature === inlineBlock.last) return;
  const previous = inlineBlock.liveRows;
  const columns = output.columns || 100;
  // Unchanged rows are never sent again: with the block already drawn, at the same width, and
  // nothing retired above it, only the rows that differ are rewritten, reached by relative motion.
  const diff = anchored && !resized && !retired.length && previous.length === inlineBlock.rows && inlineBlock.columns === columns;
  let lead = '';
  let text = '';
  let park: string;
  let nextPad = resized ? 0 : inlineBlock.pad;
  let top = inlineBlock.top;
  if (diff) {
    let at = inlineBlock.cursorRow;
    const move = (to: number): string => {
      const step = to - at;
      at = to;
      return step < 0 ? `\u001b[${-step}A` : step > 0 ? `\u001b[${step}B` : '';
    };
    // Growing past the last row: the rows it runs past would scroll the screen, so the blank rows above the conversation go
    // first and nothing blank scrolls into the saved lines. The cursor ends on the block's new top.
    const scrolls = Math.max(0, top + live.length - height);
    if (live.length > previous.length && scrolls > 0 && nextPad > 0) {
      const take = Math.min(scrolls, nextPad);
      text += `${top + at > 0 ? `\u001b[${top + at}A` : ''}\u001b[${take}M`;
      at = -(top - take);
      top -= take;
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
      top = Math.min(top, height - live.length);
    } else if (live.length < previous.length) {
      // Fewer rows: the ones the block no longer has are erased, and the composer stays where it is.
      text += `${move(live.length)}\r\u001b[J`;
    }
    park = `${move(cursorRow)}\u001b[${Math.max(1, pending.cursorColumn)}G`;
  } else {
    const body = [...retired, ...live];
    let amount = 0;
    if (clear) {
      lead = wipe ? CLEAR_SCREEN_AND_SCROLLBACK : CLEAR_SCREEN;
      inlineBlock.rows = 0;
      inlineBlock.cursorRow = 0;
      // The one absolute move: start low enough that what is printed ends on the last row.
      nextPad = Math.max(0, height - body.length);
      if (nextPad > 0) lead += `\u001b[${nextPad + 1};1H`;
      top = nextPad;
    } else {
      // Erased from the block's first row: the one the cursor report names (a block taller than the screen lost its top
      // rows, and nothing is above row zero), else the one the cursor was last left under (a lost report).
      if (found !== undefined) {
        const up = Math.max(0, inlineBlock.cursorRow + Math.min(0, found));
        lead = inlineBlock.rows ? `${up > 0 ? `\u001b[${up}A` : ''}\r\u001b[J` : '';
        eraseInlineBlock();
        top = Math.max(0, found);
      } else lead = eraseInlineBlock();
      // Past the last row: every row it runs past would scroll one into the saved lines, so the blank rows above a short conversation go first.
      amount = Math.min(Math.max(0, top + body.length - height), nextPad);
      if (amount > 0) {
        lead += `${top > 0 ? `\u001b[${top}A` : ''}\u001b[${amount}M`;
        if (top - amount > 0) lead += `\u001b[${top - amount}B`;
        nextPad -= amount;
        top -= amount;
      }
    }
    // Where the block's first row is now: where it was drawn, or the rows it ends on when printing scrolled the screen.
    top = Math.min(top + body.length - live.length, height - live.length);
    text = body.map((row, index) => `${row}\u001b[K${index < body.length - 1 ? '\r\n' : ''}`).join('');
    // The cursor is on the block's last row; walk up to the composer's.
    const back = lastRow - cursorRow;
    park = `${back ? `\u001b[${back}A` : ''}\u001b[${Math.max(1, pending.cursorColumn)}G`;
  }
  inlineBlock.pad = nextPad;
  inlineBlock.top = top;
  inlineBlock.height = height;
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
  logCursorEvent(`inline frame: block=${live.length} finished=${retired.length} composer=${cursorRow} col=${pending.cursorColumn}`);
  output.write(frame, () => {
    this.frameInFlight = false;
    if (this.pendingLive && this.canPaint('picker')) this.flushFrame();
  });
}

/** A modal surface, drawn as the whole screen on the ALTERNATE screen: the list from the top row, blank rows below a short one,
 * the composer and status on the last rows. No saved lines exist behind it in any client, and the main screen (the
 * conversation and its live block) is not touched while it is up: opening it saves that screen (`?1049h`), closing it shows
 * it again (see flushInlineFrame). A change of size just draws the page again at the new size; the rows the conversation
 * retires meanwhile are kept (inlineBlock.tail) and written when it closes. Nothing here clears the saved lines. */
function flushInlinePage(
  this: TerminalHarnessPrompter,
  finished: readonly string[],
  pending: { live: string[]; cursorRow: number; cursorColumn: number; hideCursor: boolean },
  height: number,
): void {
  const limit = Math.max(1, (output.columns || 100) - 1);
  const columns = output.columns || 100;
  const at = pending.live.length - this.chromeRows;
  const footer = pending.live.slice(at);
  const list = this.pickerOverlay.map((row) => safeRow(row, limit));
  const rows = [...list.slice(Math.max(0, list.length + footer.length - height)), ...footer];
  const blank = Math.max(0, height - rows.length);
  rows.splice(rows.length - footer.length, 0, ...Array<string>(blank).fill(''));
  const cursorRow = Math.max(0, Math.min(rows.length - 1, rows.length - footer.length + Math.max(0, pending.cursorRow - at)));
  const opening = !inlineBlock.page;
  if (opening) {
    // The main screen's block, as it stands: put back when the page closes.
    const { rows: blockRows, cursorRow: blockCursor, last, liveRows, pad, top, height: blockHeight, columns: blockColumns } = inlineBlock;
    inlineBlock.main = { rows: blockRows, cursorRow: blockCursor, last, liveRows: [...liveRows], pad, top, height: blockHeight, columns: blockColumns };
    inlineBlock.tail = [];
    inlineBlock.resized = false;
    inlineBlock.wipe = false;
    terminalModes.alternateScreen = true;
  }
  const resized = !opening && (inlineBlock.height !== height || inlineBlock.columns !== columns);
  if (resized) inlineBlock.resized = true;
  const fresh = opening || resized || inlineBlock.clearNext;
  const showCursor = !pending.hideCursor;
  const signature = JSON.stringify([rows, cursorRow, pending.cursorColumn, showCursor]);
  const modes = takeQueuedModes();
  const signals = this.pendingSignals;
  this.pendingSignals = '';
  if (inlineBlock.clearNext) {
    // The conversation was written whole (a new width): `finished` is all of it, and the main screen is cleared and given it
    // when the page closes. Not now: the main screen is not this page's to touch.
    inlineBlock.wipe = true;
    inlineBlock.tail = [...finished];
  } else inlineBlock.tail.push(...finished);
  if (!fresh && !modes && !signals && signature === inlineBlock.last) return;
  const previous = fresh ? [] : inlineBlock.liveRows;
  let text = '';
  for (const [index, row] of rows.entries()) if (previous[index] !== row) text += `\u001b[${index + 1};1H${row}\u001b[K`;
  const lead = opening ? ENTER_PAGE_SCREEN : fresh ? CLEAR_SCREEN : '';
  const park = `\u001b[${cursorRow + 1};${Math.max(1, pending.cursorColumn)}H`;
  this.frameLayout = { live: [...rows], tags: [] };
  inlineBlock.clearNext = false;
  inlineBlock.page = true;
  inlineBlock.rows = rows.length;
  inlineBlock.cursorRow = cursorRow;
  inlineBlock.last = signature;
  inlineBlock.liveRows = [...rows];
  inlineBlock.columns = columns;
  inlineBlock.height = height;
  inlineBlock.pad = 0;
  inlineBlock.top = 0;
  inlineBlock.found = undefined;
  inlineBlock.lost = false;
  this.pendingRedraw = undefined;
  this.lastPark = park;
  this.cursorShown = showCursor;
  const frame = `${syncBegin()}${modes}${signals}\u001b[?25l\u001b[?7l${lead}${text}${park}${showCursor ? '\u001b[?25h' : ''}${syncEnd()}`;
  this.frameInFlight = true;
  terminalModes.painted = true;
  logCursorEvent(`inline page: rows=${rows.length} list=${list.length} composer=${cursorRow}`);
  output.write(frame, () => {
    this.frameInFlight = false;
    if (this.pendingLive && this.canPaint('picker')) this.flushFrame();
  });
}

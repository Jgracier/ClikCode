/** The viewport: its row budget, resize handling and rewrap, and clearing the kept transcript. */
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { stdout as output } from 'node:process';
import { inlineBlock, inlineHistoryMode } from '../inline.js';
import { terminalModes } from '../restore.js';
import { logCursorEvent } from '../cursor-log.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { CURSOR_REPORT_MS, RESIZE_SETTLE_MS } from './state.js';
import { askCursorRow } from '../input-decoder.js';

/** The rows the screen announced, never fewer than five: the live block is never taller than this, so the walk back up to
 * the composer cannot clamp at the top edge. */
export function viewportRows(this: TerminalHarnessPrompter): number {
  return Math.max(5, output.rows || 30);
}

export function onResize(this: TerminalHarnessPrompter): void {
  if (!this.closed) {
    // The settled repaint redraws everything at the new size, and a change
    // of width wraps the transcript again from its source first. Until then
    // a frame asked for (a key's echo, the spinner) is a diff against what
    // was drawn: a full frame per signal is what swallowed swipes.
    logCursorEvent(`resize screen=${output.columns}x${output.rows} raw=${terminalModes.rawMode} alternate=${terminalModes.alternateScreen}`);
    // A phone sends several size changes while its keyboard moves. They are
    // debounced into ONE repaint: the clear and the phone's mouse sequence go
    // out once, inside that frame (redrawPreamble), and nothing is drawn full
    // at an intermediate size first -- that was a second blank of the screen
    // just before the settled one. A frame asked for meanwhile (a keystroke's
    // echo, a streaming row) is an ordinary diff and is not held back.
    this.requestRedraw('resize');
    // No height probe here: it jumps the cursor to the bottom-right corner
    // and asks, at exactly the moment a swipe is being recognised. The size
    // the terminal announces is what the layout uses.
    this.repaintAfterResize();
  }
}

export function repaintAfterResize(this: TerminalHarnessPrompter): void {
  if (this.resizePaintTimer) clearTimeout(this.resizePaintTimer);
  this.resizePaintTimer = setTimeout(() => {
    this.resizePaintTimer = undefined;
    lifecycle('window.resize', { cols: output.columns, rows: output.rows });
    if (this.closed || this.suspended) return;
    const rewritten = this.rewrapIfWidthChanged();
    // Whole: the preamble this frame carries clears the screen, once.
    this.forgetScreenPosition();
    if (inlineHistoryMode() && !rewritten) this.anchorBlock();
    else this.repaint();
  }, RESIZE_SETTLE_MS);
  this.resizePaintTimer.unref();
}

/** A row retired at one width is wrong at any other. Narrower, it is wider
 * than the screen: it wraps (or, with autowrap off, loses its tail) and
 * every row below it lands one out. So the transcript is not re-clipped
 * row by row but written again from its source -- the session's messages
 * and this turn's state -- exactly as opening the conversation writes it.
 * Only a change of width does this: a change of height leaves every retired
 * row as it was (see anchorBlock). Returns whether the conversation is
 * being written again. */
export function rewrapIfWidthChanged(this: TerminalHarnessPrompter): boolean {
  const columns = output.columns || 0;
  if (columns === this.transcriptColumns) return false;
  this.transcriptColumns = columns;
  this.emitted.requestReseed();
  return true;
}

/** A settled change of height, inline: the terminal moved its own rows when it resized (pulled saved lines back, added
 * blank rows at the bottom, dropped the rows below the cursor, pushed the top ones into the saved lines), and what it
 * did differs from one terminal to the next. So nothing is assumed about it: the screen is asked where its cursor is,
 * and the live block (composer, status, an open list) is erased from its first row and drawn again there, a few rows.
 * The conversation above it is never touched and never given a row, unless the block no longer fits the screen. (See
 * flushInlineFrame for what is done with the answer.) */
export function anchorBlock(this: TerminalHarnessPrompter): void {
  // A modal surface is drawn from the top row at the new size: nothing is measured (see flushInlinePage).
  if (!inlineBlock.rows || inlineBlock.page) { this.repaint(); return; }
  inlineBlock.measuring = true;
  const asked = Date.now();
  const done = (row: number | undefined): void => {
    inlineBlock.measuring = false;
    logCursorEvent(`resize cursor report ${row === undefined ? 'timed out' : `answered row ${row}`} after ${Date.now() - asked} ms`);
    // No answer is a defined failure, not a guess: the block is erased and drawn again relative to where it was last
    // left, and nothing is zeroed or re-anchored (see `lost` in flushInlineFrame). A late answer is dropped by the
    // decoder (nobody is waiting for it).
    if (row === undefined) inlineBlock.lost = true;
    else {
      inlineBlock.found = row - inlineBlock.cursorRow; // the block's first row, on the screen
      // The block is taller than the screen now: its top rows went into the saved lines, where nothing can take them out
      // again. The one case where the conversation is written again for a change of height.
      if (inlineBlock.found < 0) this.emitted.requestReseed();
    }
    if (this.closed || this.suspended) return;
    this.repaint();
  };
  askCursorRow(done, CURSOR_REPORT_MS);
}

/** Empty the transcript before the conversation is written again. What is
 * above the live region is only ever the conversation being shown: another
 * one, or this one at an old width, is dropped -- not pushed up behind a
 * screenful of blank rows, where scrolling up found it. */
export function clearTranscript(this: TerminalHarnessPrompter): void {
  // Line numbers stay unique across the rewrite, so nothing that holds one
  // can land on a row it did not mean.
  this.alternateTrimmed += this.alternateTranscript.length;
  this.alternateTranscript.length = 0;
  this.pendingFinished = [];
  this.lastFinishedRow = undefined;
  this.secondLastFinishedRow = undefined;
  this.alternateScrollback = 0;
  // Inline: the terminal's own scrollback holds the old conversation too.
  if (inlineHistoryMode()) inlineBlock.clearNext = true;
  this.messageLines.clear();
  this.lineTags.clear();
  this.callGroups.clear();
  this.stopSelectionScroll();
  this.selection = undefined;
}

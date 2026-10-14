/** The viewport: its row budget, resize handling and rewrap, and clearing the kept transcript. */
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { stdout as output } from 'node:process';
import { terminalModes } from '../restore.js';
import { logCursorEvent } from '../cursor-log.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { RESIZE_SETTLE_MS } from './state.js';

/** Never taller than the screen actually is: a live region that overflows
 * makes the walk back up to the composer clamp at the top edge, which is
 * what parks the cursor on the status line and strands rows below it. The
 * announced size is the ceiling -- a terminal that answers with more rows
 * than it announced is not offering rows we may use. */
export function viewportRows(this: TerminalHarnessPrompter): number {
  return Math.max(5, output.rows || 30);
}

export function onResize(this: TerminalHarnessPrompter): void {
  if (!this.closed) {
    // The settled repaint redraws everything at the new size, and a change
    // of width wraps the transcript again from its source first.
    this.forgetScreenPosition();
    logCursorEvent(`resize screen=${output.columns}x${output.rows} raw=${terminalModes.rawMode} alternate=${terminalModes.alternateScreen}`);
    // A phone sends several size changes while its keyboard moves: one
    // settled repaint carries the phone's resize sequence (redrawPreamble)
    // inside its frame. Written here, the modes went out interleaved with
    // frames in flight, once per intermediate size.
    const first = !this.resizePaintTimer;
    this.requestRedraw('resize');
    // The first size of a burst is drawn at once, rows only: waiting out
    // the settle left the old layout on a resized screen for 120ms. The
    // phone's sequence still goes out once, with the settled frame.
    if (first && !this.suspended) {
      this.provisionalFrame = true;
      try {
        this.rewrapIfWidthChanged();
        this.repaint();
      } finally {
        this.provisionalFrame = false;
      }
    }
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
    this.rewrapIfWidthChanged();
    // Whole, whatever the immediate frame already drew: the preamble this
    // frame carries clears the screen.
    this.forgetScreenPosition();
    this.repaint();
  }, RESIZE_SETTLE_MS);
  this.resizePaintTimer.unref();
}

/** A row retired at one width is wrong at any other. Narrower, it is wider
 * than the screen: it wraps (or, with autowrap off, loses its tail) and
 * every row below it lands one out. So the transcript is not re-clipped
 * row by row but written again from its source -- the session's messages
 * and this turn's state -- exactly as opening the conversation writes it. */
export function rewrapIfWidthChanged(this: TerminalHarnessPrompter): void {
  const columns = output.columns || 0;
  if (columns === this.transcriptColumns) return;
  this.transcriptColumns = columns;
  this.emitted.requestReseed();
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
  this.messageLines.clear();
  this.lineTags.clear();
  this.callGroups.clear();
  this.stopSelectionScroll();
  this.selection = undefined;
}

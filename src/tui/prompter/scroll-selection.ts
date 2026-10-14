/** Reading the conversation back: wheel and key scrolling with its drain, and mouse selection with its edge-follow and copy. */
import { NOTICE_MS } from '../../harness/protocol/timings.js';
import { lineAtRow, lineText, orderedRange, selectedText, selectionAction, selectionIsEmpty, type MouseAction, type Selection } from '../render/selection.js';
import { copyToClipboard } from '../../session/attachments.js';
import { logCursorEvent } from '../cursor-log.js';
import { inKeyBatch, onKeyBatchEnd } from '../input-decoder.js';
import { isMouseEvent, wheelScrollRows } from '../modes.js';
import { userError } from '../../harness/protocol/errors.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { SCROLL_DRAIN_MIN, SCROLL_DRAIN_MS, SELECTION_SCROLL_MS } from './state.js';

/** Move the viewport through the transcript. Positive scrolls back, and the
 * conversation is followed again at zero, which every new frame returns to
 * by itself once the reader lets go. Returns whether anything moved, so a
 * key that cannot scroll any further still means something to the caller. */
export function scrollTranscript(this: TerminalHarnessPrompter, rows: number): boolean {
  // Bounded by what the CURRENT screen can show -- see flushAlternateFrame.
  // Bounding it by the transcript's length instead let the offset run past
  // the end of what any frame would draw, and the rows a reader then had to
  // swipe back through before the view moved again were rows that were
  // never on it.
  const furthest = Math.max(0, this.alternateTranscript.length - this.alternateAbove);
  const next = Math.max(0, Math.min(furthest, this.alternateScrollback + rows));
  // What a report of "it did not move" needs to be answerable: whether the
  // key arrived (logged where keys are read), and whether there was anywhere
  // to go -- a screen tall enough to show the whole transcript has nothing
  // hidden above it, and refusing to move is then the right answer.
  logCursorEvent(`scroll by=${rows} from=${this.alternateScrollback} to=${next} furthest=${furthest} rows=${this.alternateTranscript.length} above=${this.alternateAbove}`);
  if (next === this.alternateScrollback) return false;
  this.alternateScrollback = next;
  this.paintingScroll = true;
  this.scheduleScrollPaint();
  return true;
}

export function drainScroll(this: TerminalHarnessPrompter): void {
  if (this.closed || this.suspended || !this.pendingScroll) return;
  const magnitude = Math.abs(this.pendingScroll);
  const step = Math.min(Math.max(1, this.viewportRows() - 1), Math.max(SCROLL_DRAIN_MIN, (magnitude * 3) >> 2));
  const applied = magnitude <= step ? this.pendingScroll : (this.pendingScroll > 0 ? step : -step);
  this.pendingScroll -= applied;
  const moved = this.scrollTranscript(applied);
  // Nowhere further to go: drop the rest rather than drain against the end.
  if (!moved) this.pendingScroll = 0;
  if (!this.pendingScroll || this.scrollDrainTimer) return;
  this.scrollDrainTimer = setTimeout(() => {
    this.scrollDrainTimer = undefined;
    this.drainScroll();
  }, SCROLL_DRAIN_MS);
  this.scrollDrainTimer.unref();
}

/** Wheel notches go here, not straight to the viewport. */
export function queueScroll(this: TerminalHarnessPrompter, rows: number): void {
  this.pendingScroll += rows;
  if (inKeyBatch()) this.drainAtBatchEnd();
  else this.drainScroll();
}

export function drainAtBatchEnd(this: TerminalHarnessPrompter): void {
  this.stopDrainBatch ??= onKeyBatchEnd(() => this.drainScroll());
}

export function scheduleScrollPaint(this: TerminalHarnessPrompter): void {
  const draw = (): void => {
    this.scrollPaintQueued = false;
    if (this.closed || this.suspended) return;
    this.repaint();
  };
  // Inside a batch the frame waits for the end of the chunk; outside one --
  // a page key, an arrow, a test pressing a single key -- it draws at once.
  if (!inKeyBatch()) { draw(); return; }
  this.scrollPaintQueued = true;
  this.stopScrollBatch ??= onKeyBatchEnd(() => { if (this.scrollPaintQueued) draw(); });
}

/** Keys that move the transcript rather than the draft, in the one place
 * both the prompt and the waiting band read them from. Reading back is
 * wanted most while a turn runs -- which is the half that had no scrolling
 * at all, so a page key or a wheel notch reached the draft editor instead.
 * Returns whether the key was spent here. */
export function handleScrollKey(this: TerminalHarnessPrompter, key: string): boolean {
  if (isMouseEvent(key)) {
    // A left press, drag or release is a selection ClikCode makes itself:
    // with mouse reporting on, the terminal's own selection never sees it.
    const action = selectionAction(key);
    if (action) { this.handleSelection(action); return true; }
    // Every other mouse report is consumed too, wheel or not: none of them
    // belongs to the composer.
    const rows = wheelScrollRows(key);
    // Queued and drained -- a flick is hundreds of notches in one read.
    if (rows) this.queueScroll(rows);
    return true;
  }
  // Ctrl+O opens the latest group's items (the live one while it runs); Esc closes them.
  if (key === '\u000f') return this.toggleGroupPanel();
  if (key === '\u001b' && this.groupPanel) return this.closeGroupPanel();
  const page = Math.max(1, this.viewportRows() - 3);
  if (key === '\u001b[5~') { this.scrollTranscript(page); return true; }
  if (key === '\u001b[6~') { this.scrollTranscript(-page); return true; }
  // Ctrl+B and Ctrl+F, a page at a time, as less and vi have always read.
  //
  // A phone keyboard has no page keys, but its key bar has ctrl, so these
  // two are reachable by hand where PageUp and PageDown are not.
  if (key === '\u0002') { this.scrollTranscript(page); return true; }
  if (key === '\u0006') { if (!this.scrollTranscript(-page)) this.noteReadingDirection(); return true; }
  return false;
}

/** Press starts a selection, drag extends it, release copies it. A click
 * that never moved selects nothing and copies nothing. No confirmation is
 * shown: the highlight is what was selected, and it clears when the text is
 * on the clipboard. Only a failure to copy says anything. */
export function handleSelection(this: TerminalHarnessPrompter, action: MouseAction): void {
  // Scrolled back, the rows below the conversation are the composer and the
  // status line: a drag reaching them is reaching for the conversation's
  // next line, which the edge scroll brings up, not for the chrome.
  const intoChrome = this.alternateScrollback > 0 && action.kind !== 'press' && action.at.row >= this.alternateAbove;
  const at = intoChrome
    ? { row: this.lineAtScreenRow(Math.max(0, this.alternateAbove - 1)), col: Number.MAX_SAFE_INTEGER }
    : { row: this.lineAtScreenRow(action.at.row), col: action.at.col };
  if (action.kind === 'press') {
    this.stopSelectionScroll();
    if (!Number.isFinite(at.row)) return;
    this.selection = { anchor: at, head: at };
    return;
  }
  const selection = this.selection;
  if (!selection) return;
  if (Number.isFinite(at.row)) selection.head = at;
  if (action.kind === 'drag') {
    this.followSelectionEdge(action.at.row, action.at.col);
    this.redrawSelection();
    return;
  }
  this.stopSelectionScroll();
  this.selection = undefined;
  // A click that never moved selects nothing; on a group's row it opens the group.
  if (selectionIsEmpty(selection)) { this.tapGroupRow(selection.anchor.row); return; }
  const text = this.selectionText(selection);
  this.redrawSelection();
  if (!text) return;
  void copyToClipboard(text).catch((error: unknown) => {
    this.showTransientNotice(userError('copy', error), NOTICE_MS, () => this.redrawSelection());
    this.redrawSelection();
  });
}

/** The conversation line screen row `row` shows (see render/selection.ts),
 * from where the view is now, not from the last frame drawn: a scroll's
 * repaint lands a moment after the scroll, and a release in between was
 * placed by the old layout -- the selection snapped back to where the drag
 * reached the edge. */
export function lineAtScreenRow(this: TerminalHarnessPrompter, row: number): number {
  return lineAtRow({
    length: this.alternateTranscript.length, trimmed: this.alternateTrimmed,
    above: this.alternateAbove, scrollback: this.alternateScrollback,
  }, row);
}

/** What a selection copies, read from the conversation itself -- all of it,
 * including the lines scrolled out of view while it was being made. */
export function selectionText(this: TerminalHarnessPrompter, selection: Selection): string {
  const range = orderedRange(selection);
  const rows: string[] = [];
  for (let line = range.start.row; line <= range.end.row; line += 1) {
    rows.push(lineText(line, this.alternateTranscript, this.alternateTrimmed, this.frameLayout.live));
  }
  const shift = (cell: { row: number; col: number }) => ({ row: cell.row - range.start.row, col: cell.col });
  return selectedText(rows, { anchor: shift(selection.anchor), head: shift(selection.head) });
}

/** A drag resting on the top row scrolls back; one resting on the bottom of
 * the conversation while it is scrolled back scrolls forward. Anywhere else
 * stops. The terminal sends a drag report only when the pointer moves, so
 * a timer carries the scroll while it is held still at the edge. */
export function followSelectionEdge(this: TerminalHarnessPrompter, row: number, col: number): void {
  const bottom = Math.max(0, this.alternateAbove - 1);
  const direction: 1 | -1 | 0 = row <= 0 ? 1 : row >= bottom && this.alternateScrollback > 0 ? -1 : 0;
  if (!direction) { this.stopSelectionScroll(); return; }
  if (this.selectionScroll?.direction === direction) { this.selectionScroll.col = col; return; }
  this.stopSelectionScroll();
  const timer = setInterval(() => this.stepSelectionScroll(), SELECTION_SCROLL_MS);
  timer.unref?.();
  this.selectionScroll = { timer, direction, col };
  this.stepSelectionScroll();
}

export function stepSelectionScroll(this: TerminalHarnessPrompter): void {
  const scroll = this.selectionScroll;
  const selection = this.selection;
  if (!scroll || !selection || this.closed || this.suspended) { this.stopSelectionScroll(); return; }
  const before = this.alternateScrollback;
  if (!this.scrollTranscript(scroll.direction)) { this.stopSelectionScroll(); return; }
  // The line under the resting pointer moved by however far the view did.
  const moved = this.alternateScrollback - before;
  selection.head = { row: selection.head.row - moved, col: scroll.direction < 0 ? Number.MAX_SAFE_INTEGER : scroll.col };
}

export function stopSelectionScroll(this: TerminalHarnessPrompter): void {
  if (!this.selectionScroll) return;
  clearInterval(this.selectionScroll.timer);
  this.selectionScroll = undefined;
}

/** The current frame again, so the highlight follows the pointer. */
export function redrawSelection(this: TerminalHarnessPrompter): void {
  if (this.closed || this.suspended || this.selecting) return;
  if (this.turn) this.paintWaiting(this.turn);
  else this.repaint();
}

/** Down at the live end moves nothing: there is nothing newer than the
 * newest. The key is still taken (inverting it was tried and nothing then
 * settled at the live end), and it no longer prints a hint: how to read back
 * -- Up or Ctrl+B -- is in /help. */
export function noteReadingDirection(this: TerminalHarnessPrompter): boolean {
  return !this.scrolledBack && this.alternateTranscript.length > 0;
}

/** Forget where on screen the live block sits: whoever writes next (the
 * shell, a vendor CLI, a resize) decides that now. */
export function forgetScreenPosition(this: TerminalHarnessPrompter): void {
  this.alternatePrevious = [];
  this.cursorShown = undefined;
}

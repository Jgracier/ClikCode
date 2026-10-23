/** One frame, start to finish: the stages below, in the order they always ran. */
import { stdout as output } from 'node:process';
import { terminalCellWidth } from '../../render/width.js';
import type { PickerOption } from '../../../harness/prompter.js';
import type { PaletteLayout } from '../../option-picker.js';
import { markTurn, turnMarkOpen } from '../../../runtime/turn-latency.js';
import { extractTags, parseTag } from '../../render/row-tags.js';
import { liveConversationLines } from '../../render/waiting.js';
import type { TerminalHarnessPrompter } from '../../prompter.js';
import { frameBands } from './bands.js';
import { frameMessages, writeTranscript } from './transcript.js';
import { queuedMessagesOf, queuedMessageRows } from './queued.js';
import { buildFooter } from './footer.js';


export function paint(this: TerminalHarnessPrompter, composer: string, options: readonly PickerOption<string>[], selected: number, prompt: string, cursor: number, palette?: PaletteLayout): void {
  const session = this.currentSession;
  if (!session || this.suspended) return;
  if (this.subView && !this.turn) this.closeSubView();
  if (this.subView) { this.pickerOverlay = []; this.paintSubView(); return; }
  if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
  this.responsePaintTimer = undefined;
  this.composer = {
    text: composer, options, selected, prompt, cursor,
    // Kept whole: a repaint (a resize) draws the list as it was asked for,
    // its section headings included.
    ...(palette ? { palette } : {}),
  };
  // The last column is never printed in. DEC autowrap is off (every frame
  // that draws re-sends `\u001b[?7l`), which makes filling it safe on a
  // terminal that honours that -- but several mobile SSH clients, and
  // anything that filters the mode out in between, wrap eagerly instead and
  // turn a full-width row into two. Every motion in a frame is relative, so
  // each such row put the walk back up to the composer one row out, which is
  // what parked the cursor on the status line below the composer instead of
  // in it. Costing one column is a far better trade than that.
  const width = Math.max(12, output.columns || 100);
  const rowWidth = width - 1;
  const inner = width - 4;
  // The conversation transcript gets its own, tighter margin: a bare
  // marker-and-space (2 columns) instead of inner's extra 2-space wrapper
  // on top of its own 4-column reservation (6 total) -- next to a native
  // CLI's own output, which runs close to the full terminal width with
  // only a bullet-and-space margin, ClikCode's wider gutter read as
  // noticeably narrower and "bleaker" for no real reason; this doesn't
  // touch inner itself, so the notice/composer/meta lines below (which
  // share it) are unaffected.
  const conversationInner = rowWidth - 2;
  const { pending, pendingPrompt, persistedMessages, hasTransientAssistant } = frameMessages(this, session);
  const bands = frameBands(this, { composer, options, prompt, cursor, palette, width, inner });
  const { targetHeight, composerRows } = bands;
  const written = writeTranscript(this, {
    session, pending, persistedMessages, hasTransientAssistant, conversationInner,
  });
  const { liveConversation, userRows, materializedPendingTurn } = written;
  // Which rows belong to a group, taken off the text here (render/row-tags.ts):
  // the transcript, the selection and the clipboard only ever see clean rows.
  const retired = extractTags(written.finished);
  const finished = retired.rows;
  const firstLine = this.alternateTrimmed + this.alternateTranscript.length + this.pendingFinished.length;
  for (const [index, tag] of retired.tags.entries()) if (tag) this.lineTags.set(firstLine + index, tag);
  // A toggled group's row, found in the rewritten transcript: the viewport is
  // anchored on it when this frame is flushed (flushAlternateFrame).
  if (this.groupAnchor && !this.emitted.pendingReseed()) {
    const anchor = this.groupAnchor;
    this.groupAnchor = undefined;
    let line: number | undefined;
    let height = 0;
    for (const [index, raw] of retired.tags.entries()) {
      const tag = parseTag(raw);
      if (!tag || tag.group !== anchor.group || (anchor.item !== '' && tag.item !== anchor.item)) continue;
      line ??= firstLine + index;
      height += 1;
    }
    if (line !== undefined) this.anchorTarget = { line, height, row: anchor.row, fit: anchor.fit };
  }
  if (this.lineTags.size > 4000) for (const line of this.lineTags.keys()) if (line < this.alternateTrimmed) this.lineTags.delete(line);
  // Decided from the rows this frame built: a steer leaves the bottom only
  // once its own row is in the answer.
  const { queuedMessages, enterAt, escAt } = queuedMessagesOf(this, session, pending, {
    steers: [...this.turnSteers.values()], ...(pendingPrompt ? { prompt: pendingPrompt } : {}), materialized: materializedPendingTurn,
  });
  liveConversation.push(...queuedMessageRows(queuedMessages, enterAt, escAt, inner, userRows));
  const conversationLines = liveConversationLines(liveConversation, true);
  const { footer, composerStart, pickerRows } = buildFooter.call(this, { inner, rowWidth, width, prompt, options, selected, palette, session, targetHeight, bands });
  // The list covers chat rows just above the footer. The footer (usage, composer, title, provider)
  // keeps its height, so it stays on the same screen rows while the list is open and while a choice
  // is applied. A list inside the footer grew it, and the composer left the screen.
  this.pickerOverlay = pickerRows;
  this.chromeRows = footer.length;
  // The live region is bounded by the viewport: it is erased and redrawn as
  // one block every frame, so it can never be taller than the terminal. A
  // construct that settles only when it closes -- a table still receiving
  // rows -- shows its tail until then, and every row of it is written on the
  // frame the block completes.
  // Scrolled back, the live conversation gives up ALL its rows, not just
  // some. flushAlternateFrame already states this intent -- "the live
  // region gives up its rows to the transcript" -- but it only achieved it
  // implicitly, through `above = height - live.length`, so whatever the
  // answer was still streaming kept a few rows and painted them directly
  // above the composer. That is the tail of a sentence being written,
  // changing several times a second, at the bottom of a page someone is
  // reading: it reads as the screen glitching, and it is the one thing on
  // screen they did not ask to look at.
  //
  // The waiting band above deliberately does NOT do this. A spinner and an
  // elapsed clock in a fixed place answer "is it still working" without
  // competing for the eye; a sentence rewriting itself does. Only the words
  // go.
  const maxLiveConversation = this.scrolledBack ? 0 : Math.max(0, targetHeight - footer.length);
  const liveConversationRows = Math.min(conversationLines.length, maxLiveConversation);
  const unbounded = [...(maxLiveConversation ? conversationLines.slice(-maxLiveConversation) : []), ...footer];
  // The hard invariant every relative motion in a frame depends on: the
  // live region fits on screen. maxLiveConversation only bounds the
  // conversation half, so a footer taller than the viewport (a palette and
  // an approval block on a short phone screen) would still overflow, and an
  // overflowing block cannot be walked back up -- the terminal stops at its
  // top row and the cursor stays that many rows low. Dropping from the top
  // costs context; not dropping costs a working cursor.
  const overflow = Math.max(0, unbounded.length - targetHeight);
  const shown = extractTags(overflow ? unbounded.slice(overflow) : unbounded);
  const live = shown.rows;
  // The composer's own row and column, whether or not the frame shows the
  // cursor: a phone client draws its caret wherever it was left, hidden or
  // not (see flushAlternateFrame). The block's last row is the status line, and a
  // caret parked there is the one every report of "the cursor is under the
  // composer" is actually describing.
  const cursorRow = Math.max(0, liveConversationRows + composerStart + composerRows.cursorRow - overflow);
  const cursorColumn = 3 + terminalCellWidth(prompt) + composerRows.cursorWidth;
  this.pendingSignals += this.terminalSignals();
  this.renderFrame(finished, live, cursorRow, cursorColumn, Boolean(palette?.hideCursor), shown.tags, extractTags(conversationLines));
  // The two moments a user feels, once per turn each (runtime/turn-latency.ts):
  // their message on screen, and the first of the answer.
  if (pendingPrompt && turnMarkOpen('first-paint')) markTurn('first-paint');
  if (this.turn && turnMarkOpen('first-text-paint') && this.liveResponse.trim()) markTurn('first-text-paint');
}


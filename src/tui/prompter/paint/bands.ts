/** The fixed bands of a frame (notice, palette, approval, thought, sign-in, plan, panel) and the rows left for the composer. */
import chalk from 'chalk';
import { noticeLines } from '../../render/wrap.js';
import { composerLayout } from '../../render/composer-layout.js';
import { terminalCellWidth, visibleSlice, visibleTail } from '../../render/width.js';
import type { PickerOption } from '../../../harness/prompter.js';
import { waitingSpinnerGlyph } from '../../../harness/protocol/activity-view.js';
import { backgroundTerminalsLabel, reasoningBody } from '../../../harness/protocol/turn-flow.js';
import { approvalBlockRows } from '../../render/approval-block.js';
import { APPROVAL_GUARD_MS } from '../../render/approval-keys.js';
import { questionBlockRows } from '../../render/question-block.js';
import { APPROVAL_MIN_ROWS, frameRowBudget } from '../../render/frame-budget.js';
import { panelRows as panelBandRows } from '../../render/footer-rows.js';
import type { PaletteLayout } from '../../option-picker.js';
import { planBlockRows } from '../../render/plan-block.js';
import type { TerminalHarnessPrompter } from '../../prompter.js';

export type BandInput = {
  composer: string; options: readonly PickerOption<string>[]; prompt: string; cursor: number; palette: PaletteLayout | undefined;
  width: number; inner: number;
};

/** The rows the frame's fixed bands take and the bands' own rows, budgeted
 * against the viewport: notice, palette, approval, thought, sign-in, plan,
 * panel, and what is left for the composer. */
export function frameBands(p: TerminalHarnessPrompter, input: BandInput) {
  const { composer, options, prompt, cursor, palette, width, inner } = input;
  // the complete terminal height is safe and important: leaving one row
  // unpainted allowed an obsolete status line to remain visibly duplicated.
  const targetHeight = p.viewportRows();
  const requestedPaletteCapacity = (typeof palette?.capacity === 'function' ? palette.capacity() : palette?.capacity)
    ?? (options.length ? Math.min(options.length, 8) + 2 : 0);
  // Keep generation at the response's live edge, directly above the
  // composer. It is a fixed status band, not transcript content, so a long
  // streamed answer cannot scroll it away. Optional bands share only the
  // rows left after one composer row and its three fixed footer rows.
  // Two rows: the generating line, and one blank above it so the text still
  // being written is not flush against the spinner. Counted here because
  // this number is the height budget -- reserve one row for a band that
  // draws two and the last line of the answer is pushed off the screen.
  //
  // This band STAYS while someone scrolls back to read. It is the answer to
  // "is it still working", and losing it mid-read leaves no sign a turn is
  // even running. What does not stay is the answer's text -- see
  // maxLiveConversation below. The distinction is the point: a spinner and
  // an elapsed clock in a fixed place are status, while a sentence being
  // rewritten under the eye is the thing that made reading impossible.
  const notice = p.mentionFocus?.status ?? p.transientNotice ?? p.currentNotice;
  const noticeShown = notice ? noticeLines(notice, inner) : [];
  const indicatorText = p.turn ? backgroundTerminalsLabel(p.backgroundTerminals) : undefined;
  const budget = frameRowBudget({
    targetHeight, waiting: Boolean(p.turn), notice: noticeShown.length, requestedPaletteCapacity,
    indicator: indicatorText !== undefined,
  });
  const { waitingRows, noticeRows, paletteRows, indicatorRows } = budget;
  let optionalRows = budget.optionalRows;
  const composerWidth = Math.max(8, inner - terminalCellWidth(prompt));
  // The software keyboard can make a mobile SSH viewport dramatically
  // shorter between two keystrokes. Bound the composer by what remains in
  // this exact frame so it can never create a physical terminal scroll.
  const approval = p.pendingApproval;
  // Never omitted (standard section 8): short of room the block degrades to
  // its question and keys (one row at the least), and the rows around it
  // give way first (fitFooterForApproval, below).
  const approvalSpace = Math.max(APPROVAL_MIN_ROWS, optionalRows - paletteRows);
  const approvalRows = approval?.question
    ? questionBlockRows(approval.question.state, width, Math.min(approvalSpace, Math.max(6, Math.floor(targetHeight * 0.6))), {
      guarded: Date.now() - approval.shownAt < APPROVAL_GUARD_MS, needsFocus: approval.needsFocus, focused: approval.focused,
    })
    : approval
    ? approvalBlockRows(approval, width, Math.min(approvalSpace, Math.max(6, Math.floor(targetHeight * 0.6))), {
      guarded: Date.now() - approval.shownAt < APPROVAL_GUARD_MS,
      needsFocus: approval.needsFocus, focused: approval.focused,
      position: p.approvalsAnswered + 1, total: p.approvalsAnswered + 1 + p.approvalQueue.length,
      canTell: Boolean(p.turn?.submit), telling: Boolean(p.tellingInstead),
    })
    : [];
  let liveBandBudget = Math.max(0, optionalRows - paletteRows - approvalRows.length - 2);
  // The newest words of the reasoning: it is read as it is written.
  const thought = p.thought ? reasoningBody(p.thought.text) : '';
  const thoughtRows = p.turn && thought && !approval && liveBandBudget > 0
    ? [`  ${chalk.dim(chalk.italic(`✻ ${visibleTail(thought, Math.max(1, inner - 2))}`))}`] : [];
  liveBandBudget -= thoughtRows.length;
  // A link sign-in's link is wrapped, never cut: on a phone it is read (and
  // its code typed) from here.
  const signInWrapped = p.turn ? p.signInLines.flatMap((line) => {
    // The link arrives as its own plain line (account.ts).
    const room = Math.max(8, inner - 2);
    if (!/^https?:\/\/\S+$/.test(line)) return [`  ${visibleSlice(line, room)}`];
    const rows: string[] = [];
    for (let at = 0; at < line.length; at += room) rows.push(`  ${chalk.underline(line.slice(at, at + room))}`);
    return rows;
  }) : [];
  const signInRows = signInWrapped.length <= liveBandBudget ? signInWrapped : signInWrapped.slice(0, Math.max(0, liveBandBudget));
  liveBandBudget -= signInRows.length;
  const planGlyph = p.turn && !p.reducedMotion ? waitingSpinnerGlyph(p.waitingFrame) : undefined;
  const planRows = paletteRows || p.selecting ? [] : planBlockRows(p.planEntries, width, liveBandBudget, planGlyph);
  liveBandBudget -= planRows.length;
  let panelRows: string[] = [];
  const panel = p.panelState;
  if (panel && !paletteRows && !approval && !p.selecting && liveBandBudget >= 3) {
    const shown = panelBandRows(panel, inner, liveBandBudget, targetHeight);
    Object.assign(panel, { page: shown.page, total: shown.total, offset: shown.offset });
    panelRows = shown.rows;
  }
  const maxComposerRows = Math.max(
    1, targetHeight - 3 - paletteRows - noticeRows - waitingRows - indicatorRows - approvalRows.length - thoughtRows.length - signInRows.length - planRows.length - panelRows.length,
  );
  const composerRows = composerLayout(composer, cursor, composerWidth, maxComposerRows);
  return {
    targetHeight, noticeShown, noticeRows, waitingRows, paletteRows, indicatorRows, indicatorText, approvalRows,
    thoughtRows, signInRows, planRows, panelRows, maxComposerRows, composerRows,
  };
}


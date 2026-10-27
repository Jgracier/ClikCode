/** The fixed bands of a frame (palette, approval, thought, sign-in, plan, panel) and the rows left for the composer. */
import chalk from 'chalk';
import { thoughtLine } from '../../../harness/protocol/tool-category-style.js';
import { noticeLines } from '../../render/wrap.js';
import { composerLayout } from '../../render/composer-layout.js';
import { terminalCellWidth, visibleSlice, visibleTail } from '../../render/width.js';
import { HYPERLINK_CLOSE, hyperlinkOpen } from '../../render/hyperlinks.js';
import { SAFE_LINK } from '../../render/text.js';
import type { PickerOption } from '../../../harness/prompter.js';
import { waitingSpinnerGlyph } from '../../../harness/protocol/activity-view.js';
import { backgroundTerminalsLabel, reasoningBody } from '../../../harness/protocol/turn-flow.js';
import { approvalBlockRows } from '../../render/approval-block.js';
import { APPROVAL_GUARD_MS } from '../../render/approval-keys.js';
import { questionBlockRows } from '../../render/question-block.js';
import { APPROVAL_MIN_ROWS, FOOTER_CHROME_ROWS, MIN_COMPOSER_ROWS, frameRowBudget } from '../../render/frame-budget.js';
import { panelRows as panelBandRows } from '../../render/footer-rows.js';
import type { PaletteLayout } from '../../option-picker.js';
import { planBlockRows } from '../../render/plan-block.js';
import type { TerminalHarnessPrompter } from '../../prompter.js';

type BandInput = {
  composer: string; options: readonly PickerOption<string>[]; prompt: string; cursor: number; palette: PaletteLayout | undefined;
  width: number; inner: number;
};

/** Every visible row of a long consent URL opens the same complete URL.
 * Mobile SSH clients may not identify themselves through TERM_PROGRAM, so
 * link detection cannot decide whether a consent row gets an OSC 8 target. */
export function signInUrlRows(url: string, room: number): string[] {
  const rows: string[] = [];
  const width = Math.max(1, room);
  for (let at = 0; at < url.length; at += width) {
    const part = url.slice(at, at + width);
    rows.push(`  ${chalk.underline(SAFE_LINK.test(url) ? `${hyperlinkOpen(url)}${part}${HYPERLINK_CLOSE}` : part)}`);
  }
  return rows;
}

/** The rows the frame's fixed bands take and the bands' own rows, budgeted
 * against the viewport: notice, palette, approval, thought, sign-in, plan,
 * panel, and what is left for the composer. */
export function frameBands(p: TerminalHarnessPrompter, input: BandInput) {
  const { composer, options, prompt, cursor, palette, width, inner } = input;
  const conversation = p.surface === 'conversation';
  const turn = conversation ? p.turn : undefined;
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
  const notice = (conversation ? p.mentionFocus?.status : undefined) ?? p.transientNotice;
  // A notice is drawn over the chat above the footer, like a list: a notice
  // that took footer rows moved the composer when it came and again when it
  // expired.
  const noticeShown = notice ? noticeLines(notice, inner) : [];
  // Beside the status while a turn runs: what is running in the background, and a download this chat asked for.
  const transfer = conversation && p.currentSession ? p.transferOf(p.currentSession.id) : undefined;
  const indicatorText = turn ? [backgroundTerminalsLabel(p.backgroundTerminals), transfer].filter(Boolean).join(' · ') || undefined : undefined;
  const budget = frameRowBudget({ targetHeight, waiting: Boolean(turn), requestedPaletteCapacity });
  const { waitingRows, paletteRows, optionalRows } = budget;
  const composerWidth = Math.max(8, inner - terminalCellWidth(prompt));
  // The software keyboard can make a mobile SSH viewport dramatically
  // shorter between two keystrokes. Bound the composer by what remains in
  // this exact frame so it can never create a physical terminal scroll.
  const approval = conversation ? p.pendingApproval : undefined;
  // Never omitted (standard section 8): short of room the block degrades to
  // its question and keys (one row at the least), and the rows around it
  // give way first (fitFooterForApproval, below).
  // The list is not in this budget. It is drawn over the chat, above the footer
  // (frame-flush.ts), so giving it rows here would shrink the composer, the
  // plan or an approval, and the composer would move when the list opened.
  const approvalSpace = Math.max(APPROVAL_MIN_ROWS, optionalRows);
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
  let liveBandBudget = Math.max(0, optionalRows - approvalRows.length - 2);
  // The newest words of the reasoning: it is read as it is written. It is
  // drawn in the blank row over the status, which exists whether or not there
  // is a thought: a row of its own appeared with the first thought and went
  // with the first text, once for every reasoning/acting cycle of a turn.
  const thought = p.thought ? reasoningBody(p.thought.text) : '';
  const thoughtRow = turn && thought && !approval && waitingRows >= 2
    ? `  ${thoughtLine(visibleTail(thought, Math.max(1, inner - 2)))}` : undefined;
  // A link sign-in's link is wrapped, never cut: on a phone it is read (and
  // its code typed) from here.
  const signInWrapped = turn ? p.signInLines.flatMap((line) => {
    // The link arrives as its own plain line (account.ts).
    const room = Math.max(8, inner - 2);
    if (!/^https?:\/\/\S+$/.test(line)) return [`  ${visibleSlice(line, room)}`];
    return signInUrlRows(line, room);
  }) : [];
  const signInRows = signInWrapped.length <= liveBandBudget ? signInWrapped : signInWrapped.slice(0, Math.max(0, liveBandBudget));
  liveBandBudget -= signInRows.length;
  // The step in progress turns only when it is the single one: several would spin in step with each other
  // and with the status line, saying nothing the status does not.
  const activeSteps = p.planEntries.filter((entry) => entry.status === 'in_progress').length;
  const planGlyph = turn && !p.reducedMotion && activeSteps === 1 ? waitingSpinnerGlyph(p.waitingFrame) : undefined;
  const planShown = conversation ? planBlockRows(p.planEntries, width, liveBandBudget, planGlyph) : [];
  // The plan's height only grows during a turn: a step done or added changes
  // its rows, and a block that shrank and grew with them moved the chat at
  // every update. Rows it no longer needs stay blank until the turn ends.
  if (conversation) p.planHold = turn ? Math.max(p.planHold, Math.min(planShown.length, liveBandBudget)) : 0;
  const planRows = turn ? [...planShown, ...Array.from({ length: Math.max(0, Math.min(p.planHold, liveBandBudget) - planShown.length) }, () => '')] : planShown;
  liveBandBudget -= planRows.length;
  let panelRows: string[] = [];
  const panel = conversation ? p.panelState : undefined;
  if (panel && !approval && liveBandBudget >= 3) {
    const shown = panelBandRows(panel, inner, liveBandBudget, targetHeight);
    Object.assign(panel, { page: shown.page, total: shown.total, offset: shown.offset });
    panelRows = shown.rows;
  }
  const maxComposerRows = Math.max(
    MIN_COMPOSER_ROWS, targetHeight - FOOTER_CHROME_ROWS - waitingRows - approvalRows.length - signInRows.length - planRows.length - panelRows.length,
  );
  const composerRows = composerLayout(composer, cursor, composerWidth, maxComposerRows);
  return {
    targetHeight, noticeShown, waitingRows, paletteRows, indicatorText, approvalRows,
    thoughtRow, signInRows, planRows, panelRows, maxComposerRows, composerRows,
  };
}


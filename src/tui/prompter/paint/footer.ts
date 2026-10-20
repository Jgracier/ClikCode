/** The footer of a frame: notice, palette, panel, plan, approval, status, composer and rules, fitted under an approval. */
import chalk from 'chalk';
import type { PaletteEntry } from '../../command-palette.js';
import { terminalCellWidth, visibleSlice } from '../../render/width.js';
import type { PickerOption } from '../../../harness/prompter.js';
import { fitFooterForApproval } from '../../render/frame-budget.js';
import { paletteRows as paletteBandRows } from '../../render/footer-rows.js';
import type { PaletteLayout } from '../../option-picker.js';
import { composerUsageLabel, paintTitleRule, paintUsageRule } from '../../render/waiting.js';
import type { TerminalHarnessPrompter } from '../../prompter.js';
import type { HarnessSession } from '../../../session/model.js';
import { frameBands } from './bands.js';


export type FooterInput = {
  inner: number; rowWidth: number; width: number; prompt: string; options: readonly PickerOption<string>[]; selected: number;
  palette: PaletteLayout | undefined; session: HarnessSession; targetHeight: number;
  bands: ReturnType<typeof frameBands>;
};

/** The footer's rows, where the composer starts in them, and an open list.
 * The list is not part of the footer: a footer that grows moves the composer, and the chat with it. */
export function buildFooter(this: TerminalHarnessPrompter, input: FooterInput): { footer: string[]; composerStart: number; pickerRows: string[] } {
  const { inner, rowWidth, width, prompt, options, selected, palette, session, targetHeight, bands } = input;
  const {
    noticeShown, noticeRows, waitingRows, paletteRows: paletteCapacity, indicatorRows, indicatorText, approvalRows,
    thoughtRows, signInRows, planRows, panelRows, composerRows,
  } = bands;
  const meta = this.statusText(inner);
  const footer: string[] = [];
  // The resting composer starts with a clear row, or its rule sits directly
  // on the last line of the answer. While a turn runs the generating band
  // already carries its own blank, budgeted into the height -- adding a
  // second one there would double the gap and push an answer row off.
  // The row count is the same on both sides of a turn's end -- the band's
  // blank and its status line become two blank rows -- so nothing under or
  // above the composer shifts when the status goes.
  if (!this.turn) footer.push('', ...(targetHeight >= 5 && !approvalRows.length ? [''] : []));
  footer.push(...noticeShown.slice(0, noticeRows).map((row) => `  ${chalk.yellow(row)}`));
  const pickerRows: string[] = [];
  if (paletteCapacity) {
    if (palette?.title) pickerRows.push(`  ${chalk.bold(visibleSlice(palette.title, Math.max(1, inner)))}`);
    pickerRows.push(...paletteBandRows(options as readonly PaletteEntry[], selected, paletteCapacity, width, {
      ...(palette?.headings ? { headings: true } : {}), ...(palette?.hint ? { hint: palette.hint } : {}),
    }));
  }
  footer.push(...panelRows, ...planRows);
  const aboveApproval = footer.length;
  const midRows = [...thoughtRows, ...(signInRows.length ? ['', ...signInRows] : [])];
  footer.push(...approvalRows, ...midRows);
  // The generating band: a blank above the status where the height has the
  // row for it. The status itself is always drawn while a turn runs.
  const statusBlank = waitingRows >= 2 && this.turn ? '' : undefined;
  const statusRow = this.turn ? `  ${visibleSlice(this.waitingLine(this.turn, Math.max(1, inner)), Math.max(1, inner))}` : undefined;
  if (statusBlank !== undefined) footer.push(statusBlank);
  if (statusRow !== undefined) footer.push(statusRow);
  // Background terminals the vendor runs: one dim row under the status,
  // not drawn at zero, and the first row a short terminal gives up.
  const indicatorRow = indicatorRows && indicatorText !== undefined
    ? `  ${chalk.dim(visibleSlice(indicatorText, Math.max(1, inner)))}` : undefined;
  if (indicatorRow !== undefined) footer.push(indicatorRow);
  // Usage lives on the upper composer border, mirroring the title on the
  // lower border. A spent window replaces the percentage with the reset
  // itself (`Resets 5:34PM`); a spent balance says `Out Of Credits`.
  const usageRule = paintUsageRule(rowWidth, composerUsageLabel(this.usageLabel, this.usageResetLabel));
  footer.push(usageRule);
  let composerStart = footer.length;
  const composerFooter: string[] = [];
  for (const [index, row] of composerRows.rows.entries()) {
    // The caret is drawn in the same foreground as the rules and the text
    // between them, so the whole composer reads as one field: white frame,
    // white prompt, white input.
    composerFooter.push(`  ${index === 0 ? chalk.bold(prompt) : ' '.repeat(terminalCellWidth(prompt))}${row}`);
  }
  footer.push(...composerFooter);
  // The rule below the composer carries the chat's title at its right
  // edge instead of a plain dashed line -- dashes fill from the left up to
  // wherever the title starts, so a longer title just eats more of the
  // rule rather than needing a line of its own. Provider/model/directory
  // (meta) stay on their own separate line below, never sharing space with
  // the title the way they used to.
  // A name cut from the chat's first message is already on screen as that message: the rule says a name only when it adds something.
  // The board's composer starts a NEW conversation, so it carries no title: the last chat's name there read as its draft.
  // A picker names itself above its list, so the chat's name stays on this rule.
  // Clearing it while the list is open rewrites the rule under the composer.
  // The board sets headings and no title: its composer starts a new chat, and
  // the chat that was open is not named there.
  const titleRule = paintTitleRule(rowWidth, (palette?.headings && !palette.title) || session.nameSource === 'message' ? undefined : session.name || undefined);
  footer.push(titleRule);
  // Provider, model, effort and directory are one statement -- what this
  // conversation is running as -- so they read as one line in one colour
  // rather than a bright word followed by a dimmer tail. Cyan is ClikCode's
  // own chrome, the same family as the caret above it.
  const metaRow = `  ${chalk.cyan(meta)}`;
  footer.push(metaRow);
  // A short terminal with an approval up: the rows that are not the prompt
  // go first, so it is never the prompt that is cut off the top.
  if (approvalRows.length && footer.length > targetHeight) {
    const fitted = fitFooterForApproval({
      above: footer.slice(0, aboveApproval), approval: approvalRows, mid: midRows, blank: statusBlank, status: statusRow,
      indicator: indicatorRow,
      usageRule, composer: composerFooter, titleRule, meta: metaRow, height: targetHeight,
    });
    footer.splice(0, footer.length, ...fitted.rows);
    composerStart = fitted.composerStart;
  }
  return { footer, composerStart, pickerRows };
}


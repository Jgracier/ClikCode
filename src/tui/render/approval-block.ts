/** The approval prompt: what a pending tool call looks like, and which keys
 * answer it. */

import chalk from 'chalk';
import { sanitizeTerminalText } from './text.js';
import { visibleSlice } from './width.js';
import { wrapCodeLine, wrapWords } from './wrap.js';

/** How long an approval ignores every key after it appears. A person typing
 * into the composer cannot stop within a frame of a prompt popping up; without
 * this the `y` of whatever word they were on approved a tool call. */
export const APPROVAL_GUARD_MS = 400;

export type ApprovalPreview = {
  /** Either unified-diff style lines, or the two sides of an edit. */
  diff?: readonly string[] | { removed: readonly string[]; added: readonly string[] };
};

export type ApprovalRequest = { title: string; detail?: string; preview?: ApprovalPreview; resolve: (accepted: boolean) => void };

const APPROVAL_DIFF_PREVIEW_LINES = 8;

/** What one key means to a pending approval. The rule, in full:
 *  - every key is ignored for the first APPROVAL_GUARD_MS;
 *  - Esc and Ctrl+C always deny (neither can be part of a draft);
 *  - if the composer held a draft when the approval appeared, Tab must be
 *    pressed first to focus the approval -- until then y/n/Enter are ignored,
 *    because they are exactly the characters the user is in the middle of
 *    typing;
 *  - then y/Y allows once, n/N and Enter (the default) deny.
 * Nothing typed while an approval is pending ever reaches the draft. */
export function approvalKeyAction(
  key: string, elapsedMs: number, needsFocus: boolean, focused: boolean,
): 'allow' | 'deny' | 'focus' | 'ignore' {
  if (elapsedMs < APPROVAL_GUARD_MS) return 'ignore';
  if (key === '\u001b' || key === '\u0003') return 'deny';
  if (needsFocus && !focused) return key === '\t' ? 'focus' : 'ignore';
  if (key === 'y' || key === 'Y') return 'allow';
  if (key === 'n' || key === 'N' || key === '\r' || key === '\n') return 'deny';
  return 'ignore';
}

/** The approval as its own block of rows. The full command/path is wrapped,
 * never clipped to a fragment of one status line, and the answer row is never
 * truncated: what is being approved and how to answer are the two things this
 * prompt exists to show. When the block cannot fit, detail rows are dropped
 * from the middle and the count of hidden rows is stated. */
export function approvalBlockRows(
  request: { title: string; detail?: string; preview?: ApprovalPreview }, width: number, maxRows: number,
  state: { guarded: boolean; needsFocus: boolean; focused: boolean; queued: number },
): string[] {
  const inner = Math.max(8, width - 4);
  const clean = (text: string): string => sanitizeTerminalText(text);
  const title = wrapWords(`${clean(request.title).replace(/\s+/g, ' ').trim()}${state.queued ? `  (+${state.queued} waiting)` : ''}`, inner - 2)
    .map((line, index) => `  ${index === 0 ? chalk.yellow('?') : ' '} ${chalk.bold(line)}`);
  const detail = request.detail === undefined ? []
    : clean(request.detail).split('\n').flatMap((line) => wrapCodeLine(line, inner - 2)).map((line) => `    ${line}`);
  const diffSource = request.preview?.diff;
  const diffLines = !diffSource ? []
    : Array.isArray(diffSource) ? (diffSource as readonly string[]).map((line) => clean(line))
      : [
        ...(diffSource as { removed: readonly string[] }).removed.map((line) => `- ${clean(line)}`),
        ...(diffSource as { added: readonly string[] }).added.map((line) => `+ ${clean(line)}`),
      ];
  const shownDiff = diffLines.slice(0, APPROVAL_DIFF_PREVIEW_LINES).map((line) => {
    const clipped = visibleSlice(line.replace(/\n/g, ' '), inner - 2);
    return `    ${line.startsWith('+') ? chalk.green(clipped) : line.startsWith('-') ? chalk.red(clipped) : clipped}`;
  });
  if (diffLines.length > shownDiff.length) shownDiff.push(`    ${chalk.dim(`+${diffLines.length - shownDiff.length} more`)}`);
  const keys = width >= 46 ? '[y] yes  [n] no  [esc] deny' : '[y] [n] [esc]';
  const question = state.needsFocus && !state.focused
    ? (width >= 72 ? `Draft kept. Press [tab] to answer, then ${keys}` : `[tab] to answer · ${keys}`)
    : `Allow once? ${keys}`;
  const answer = `  ${state.guarded ? chalk.dim(question) : chalk.bold(question)}`;
  const body = [...detail, ...shownDiff];
  const room = Math.max(0, maxRows - title.length - 1);
  if (body.length > room) {
    const kept = Math.max(0, room - 1);
    const hidden = body.length - kept;
    body.splice(kept, body.length - kept, ...(room > 0 ? [`    ${chalk.dim(`… ${hidden} more row${hidden === 1 ? '' : 's'}`)}`] : []));
  }
  return [...title.slice(0, Math.max(1, maxRows - 1)), ...body, answer];
}

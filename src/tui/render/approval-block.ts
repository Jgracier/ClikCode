/** The approval prompt: what a pending tool call looks like, and which keys
 * answer it. */

import { fileDiffRows } from '../../harness/protocol/activity-line.js';
import type { FileDiff } from '../../agent/line-diff.js';
import chalk from 'chalk';
import { sanitizeTerminalText } from './text.js';
import { visibleSlice } from './width.js';
import { wrapCodeLine, wrapWords } from './wrap.js';
export { APPROVAL_GUARD_MS, approvalKeyAction } from './approval-keys.js';

export type ApprovalPreview = {
  /** What the call would change, file by file -- the same hunks an edit's
   * row shows once it has run. */
  diff?: FileDiff[];
};

/** `rule` is the permission rule this request could be answered with once and
 *  for all -- e.g. `Bash(npm test:*)`. Present only where the caller can
 *  actually persist one, so the "always" answer is never offered when nothing
 *  would remember it. */
export type ApprovalRequest = {
  title: string; detail?: string; preview?: ApprovalPreview; rule?: string;
  resolve: (accepted: boolean | 'always') => void;
};

const APPROVAL_DIFF_PREVIEW_LINES = 8;

/** The approval as its own block of rows. The full command/path is wrapped,
 * never clipped to a fragment of one status line, and the answer row is never
 * truncated: what is being approved and how to answer are the two things this
 * prompt exists to show. When the block cannot fit, detail rows are dropped
 * from the middle and the count of hidden rows is stated. */
export function approvalBlockRows(
  request: { title: string; detail?: string; preview?: ApprovalPreview; rule?: string }, width: number, maxRows: number,
  state: {
    guarded: boolean; needsFocus: boolean; focused: boolean;
    /** Which of the approvals waiting together this is, and how many there
     * are: "Approval 1 of 3". Nothing is said about a lone one. */
    position?: number; total?: number;
    /** The [t] key is offered: the caller can send an instruction instead. */
    canTell?: boolean;
    /** [t] was pressed: the instruction is being typed in the composer. */
    telling?: boolean;
  },
): string[] {
  const inner = Math.max(8, width - 4);
  const clean = (text: string): string => sanitizeTerminalText(text);
  const count = state.total && state.total > 1 ? `Approval ${state.position ?? 1} of ${state.total} · ` : '';
  const title = wrapWords(`${count}${clean(request.title).replace(/\s+/g, ' ').trim()}`, inner - 2)
    .map((line, index) => `  ${index === 0 ? chalk.yellow('?') : ' '} ${chalk.bold(line)}`);
  const detail = request.detail === undefined ? []
    : clean(request.detail).split('\n').flatMap((line) => wrapCodeLine(line, inner - 2)).map((line) => `    ${line}`);
  const files = request.preview?.diff?.map((file) => ({ ...file, lines: file.lines.map((line) => ({ ...line, text: clean(line.text).replace(/\n/g, ' ') })) }));
  const shownDiff = files?.length ? fileDiffRows(files, APPROVAL_DIFF_PREVIEW_LINES).map((line) => visibleSlice(line, inner + 2)) : [];
  // The "always" key is offered only when a rule came with the request, and
  // the rule itself is shown: "always" has to say what it will remember, or
  // the user is agreeing to something unstated.
  // "No, and tell it what to do instead" (Claude Code's third answer) where
  // the text can be sent: typed in the composer, sent as a steer.
  const tell = state.canTell ? 18 : 0;
  const keys = request.rule
    ? (width >= 60 + tell ? `[y] once  [a] always  [n] no${tell ? '  [t] tell it instead' : ''}  [esc] deny` : `[y] [a] [n]${tell ? ' [t]' : ''} [esc]`)
    : (width >= 46 + tell ? `[y] yes  [n] no${tell ? '  [t] tell it instead' : ''}  [esc] deny` : `[y] [n]${tell ? ' [t]' : ''} [esc]`);
  const lead = request.rule && width >= 60 + tell ? `Allow? ${chalk.dim(`always = ${request.rule}`)} ` : 'Allow once? ';
  const question = state.telling
    ? (width >= 72 ? 'No — type what it should do instead below · [enter] send · [esc] back' : 'Type it below · [enter] send · [esc] back')
    : state.needsFocus && !state.focused
      ? (width >= 72 ? `Draft kept. Press [tab] to answer, then ${keys}` : `[tab] to answer · ${keys}`)
      : `${lead}${keys}`;
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

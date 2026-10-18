/** A harness's question in the waiting band: its rows, and what each key does.
 * Shares the approval's guard and focus rules (approval-keys.ts) so a word
 * being typed never answers it, and is pure so both are testable. */

import chalk from 'chalk';
import type { HarnessQuestion, HarnessQuestionRequest } from '../../harness/events/question.js';
import { APPROVAL_GUARD_MS } from './approval-keys.js';
import { sanitizeTerminalText } from './text.js';
import { visibleSlice } from './width.js';
import { wrapWords } from './wrap.js';

export interface QuestionPromptState {
  request: HarnessQuestionRequest;
  question: HarnessQuestion;
  /** Which question of the request this is (1-based), and how many. */
  position: number;
  total: number;
  highlight: number;
  /** Multi-select: indexes of the options ticked. */
  picked: Set<number>;
  /** The composer is taking the answer's text. */
  typing: boolean;
  /** Values collected from the earlier questions of the request. */
  collected: Record<string, string[]>;
}

type QuestionRow = { kind: 'option' | 'other' | 'skip'; label: string; description?: string };

/** The choices as drawn: the options, then "Other…" where text is welcome
 * beside them, then Skip where the question may go unanswered. */
export function questionRows(question: HarnessQuestion): QuestionRow[] {
  const rows: QuestionRow[] = question.options.map((option) => ({ kind: 'option', label: option.label, ...(option.description ? { description: option.description } : {}) }));
  if (question.options.length && question.allowFreeText) rows.push({ kind: 'other', label: 'Other…', description: 'type your own answer' });
  if (question.optional) rows.push({ kind: 'skip', label: 'Skip' });
  return rows;
}

/** A question with no options is answered by typing, from the start. */
export function startsTyping(question: HarnessQuestion): boolean {
  return question.options.length === 0;
}

type QuestionKeyAction =
  | { type: 'ignore' }
  | { type: 'focus' }
  | { type: 'cancel' }
  | { type: 'back' }
  | { type: 'move'; to: number }
  | { type: 'choose'; index: number }
  | { type: 'toggle'; index: number }
  | { type: 'submit' }
  | { type: 'type' };

export function questionKeyAction(
  key: string, state: QuestionPromptState, elapsedMs: number, needsFocus: boolean, focused: boolean,
): QuestionKeyAction {
  if (elapsedMs < APPROVAL_GUARD_MS) return { type: 'ignore' };
  if (key === '\u0003') return { type: 'cancel' };
  if (needsFocus && !focused) return key === '\t' ? { type: 'focus' } : { type: 'ignore' };
  if (state.typing) {
    if (key === '\u001b') return startsTyping(state.question) ? { type: 'cancel' } : { type: 'back' };
    if (key === '\r' || key === '\n') return { type: 'submit' };
    return { type: 'type' };
  }
  const rows = questionRows(state.question);
  const last = Math.max(0, rows.length - 1);
  if (key === '\u001b') return { type: 'cancel' };
  if (key === '\u001b[A' || key === 'k') return { type: 'move', to: Math.max(0, state.highlight - 1) };
  if (key === '\u001b[B' || key === 'j') return { type: 'move', to: Math.min(last, state.highlight + 1) };
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    if (index > last) return { type: 'ignore' };
    return state.question.multiSelect && rows[index]!.kind === 'option' ? { type: 'toggle', index } : { type: 'choose', index };
  }
  if (key === ' ' && state.question.multiSelect && rows[state.highlight]?.kind === 'option') return { type: 'toggle', index: state.highlight };
  if (key === '\r' || key === '\n') {
    const row = rows[state.highlight];
    if (!row) return { type: 'ignore' };
    if (state.question.multiSelect && row.kind === 'option') return state.picked.size ? { type: 'submit' } : { type: 'toggle', index: state.highlight };
    return { type: 'choose', index: state.highlight };
  }
  return { type: 'ignore' };
}

/** The question as its own block of rows; the options and the key row are
 * never clipped (a long prompt loses its middle instead). */
export function questionBlockRows(
  state: QuestionPromptState, width: number, maxRows: number,
  flags: { guarded: boolean; needsFocus: boolean; focused: boolean },
): string[] {
  const inner = Math.max(8, width - 4);
  const clean = (text: string): string => sanitizeTerminalText(text);
  const { question } = state;
  const count = state.total > 1 ? `${state.position}/${state.total} · ` : '';
  const lead = clean(question.header ?? state.request.title);
  const source = question.header && state.total === 1 ? chalk.dim(` · ${clean(state.request.title)}`) : '';
  const head = [`  ${chalk.yellow('?')} ${chalk.dim(count)}${chalk.bold(lead)}${source}`];
  const prompt = clean(question.prompt).split('\n').flatMap((line) => wrapWords(line, inner - 2)).map((line) => `    ${line}`);
  const link = state.request.url ? [`    ${chalk.underline(clean(state.request.url))}`] : [];
  const rows = questionRows(question);
  const list = state.typing && !startsTyping(question) ? [] : rows.map((row, index) => {
    const on = index === state.highlight;
    const mark = question.multiSelect && row.kind === 'option' ? (state.picked.has(index) ? '[x]' : '[ ]') : ' ';
    const label = `${on ? chalk.cyan('›') : ' '} ${index < 9 ? `${index + 1}.` : '  '} ${mark === ' ' ? '' : `${mark} `}${clean(row.label)}`;
    const detail = row.description ? ` ${chalk.dim(`— ${clean(row.description)}`)}` : '';
    return `    ${on ? chalk.bold(label) : label}${detail}`;
  });
  const hint = state.typing
    ? (question.secret
      ? `${question.maskInput === false ? '' : 'Input hidden · '}[enter] continue`
      : 'Type it below · [enter] send') + (startsTyping(question) ? ' · [esc] cancel' : ' · [esc] back')
    : question.multiSelect ? '[↑↓] move  [space] tick  [enter] done  [esc] cancel' : '[↑↓] move  [enter] choose  [1-9] pick  [esc] cancel';
  const needs = flags.needsFocus && !flags.focused;
  const answer = `  ${flags.guarded || needs ? chalk.dim(needs ? `Draft kept. Press [tab] to answer · ${hint}` : hint) : chalk.bold(hint)}`;
  // Too few rows for every option: the ones around the highlighted one, so
  // what Enter would choose is always on screen. The prompt and the link go
  // first, then the options' far ends (the keys row is never given up).
  const listRows = Math.max(1, maxRows - head.length - 1);
  if (maxRows <= head.length + 1) {
    // No row for a list at all: the highlighted option rides on the question's
    // own row, and the keys below it move and choose.
    const on = rows[state.highlight];
    const marked = on ? `${head[0]} ${chalk.cyan('›')} ${chalk.bold(clean(on.label))}` : head[0]!;
    return [visibleSlice(marked, Math.max(8, width - 1)), answer];
  }
  if (list.length > listRows) {
    const start = Math.min(Math.max(0, state.highlight - Math.floor((listRows - 1) / 2)), list.length - listRows);
    list.splice(0, list.length, ...list.slice(start, start + listRows));
  }
  const body = [...prompt, ...link];
  const room = Math.max(0, maxRows - head.length - list.length - 1);
  if (body.length > room) {
    const kept = Math.max(0, room - 1);
    const hidden = body.length - kept;
    body.splice(kept, body.length - kept, ...(room > 0 ? [`    ${chalk.dim(`… ${hidden} more row${hidden === 1 ? '' : 's'}`)}`] : []));
  }
  return [...head, ...body, ...list, answer];
}

/** The values a key-driven answer settles on for the current question:
 * undefined when the question is not finished yet. */
export function questionValues(state: QuestionPromptState, row: QuestionRow | undefined, typed?: string): string[] {
  if (state.question.multiSelect) {
    const values = [...state.picked].sort((a, b) => a - b).map((index) => state.question.options[index]!.label);
    return typed ? [...values, typed] : values;
  }
  if (typed !== undefined) return typed ? [typed] : [];
  return row?.kind === 'option' ? [row.label] : [];
}

export { APPROVAL_GUARD_MS };

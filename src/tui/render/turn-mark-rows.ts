/** A saved turn's durable marks (session/model.ts TurnMark) as rows, and the
 * one order they and the turn's calls are drawn in when a conversation is
 * reopened or joined (standards 1, 4, 7, 8, 11).
 *
 * Pure of the prompter: the prompter feeds these rows to the same grouping
 * and interleaving a live turn goes through, so a reopened turn reads as it
 * did while it ran. */

import chalk from 'chalk';
import { look, thoughtLine } from '../../harness/protocol/tool-category-style.js';
import { orderMarks } from '../../harness/protocol/activity-view.js';
import { decisionRow, thoughtRow, type Decision } from '../../harness/protocol/turn-flow.js';
import type { TurnActivity, TurnMark } from '../../session/model.js';
import type { GroupThought } from '../../harness/protocol/call-groups.js';
import { sanitizeTerminalText } from './text.js';

/** Steps of a plan drawn before the rest are counted. */
const PLAN_ROWS = 12;

/** A mark's rows, styled the way each one is drawn live: the first row is
 * the call-level row, any others are drawn under it. */
export function turnMarkLines(mark: TurnMark): string[] {
  const clean = (text: string): string => sanitizeTerminalText(text, { singleLine: true }).trim();
  switch (mark.kind) {
    case 'thought':
      return [thoughtLine(clean(thoughtRow({ durationMs: mark.durationMs, ...(mark.heading ? { heading: mark.heading } : {}) })))];
    case 'notice':
      return clean(mark.message) ? [chalk.dim(clean(mark.message))] : [];
    case 'outcome': {
      const { text, tone } = decisionRow({ kind: mark.outcome, label: clean(mark.label) });
      const paint = tone === 'no' ? look.paint.failed : tone === 'told' ? look.paint.accent : look.paint.success;
      return [paint(text.slice(0, 1)) + chalk.dim(text.slice(1))];
    }
    case 'plan': {
      if (!mark.entries.length) return [];
      const done = mark.entries.filter((entry) => entry.status === 'completed').length;
      const steps = mark.entries.slice(0, PLAN_ROWS).map((entry) => {
        const text = clean(entry.content);
        return entry.status === 'completed' ? `${chalk.green('☑')} ${chalk.dim(text)}`
          : entry.status === 'in_progress' ? `${chalk.cyan('◐')} ${chalk.bold(text)}`
            : entry.status === 'cancelled' ? `${chalk.dim('☒')} ${chalk.dim.strikethrough(text)}` : `☐ ${text}`;
      });
      const more = mark.entries.length - steps.length;
      return [
        chalk.dim(`Plan · ${done}/${mark.entries.length} done`), ...steps,
        ...(more > 0 ? [chalk.dim(`… ${more} more`)] : []),
      ];
    }
  }
}

/** What a saved thought keeps for expansion. */
export function markThought(mark: Extract<TurnMark, { kind: 'thought' }>): GroupThought {
  return { durationMs: mark.durationMs, ...(mark.heading ? { heading: mark.heading } : {}), ...(mark.text ? { text: mark.text } : {}) };
}

/** The decision an outcome mark that names its call stands for: settled onto
 * that call's row (settleDecisionEntry) instead of drawn as a second row
 * (standard section 8). Undefined for any other mark, and for an outcome
 * saved with no call id, which keeps its own row as it always had. */
export function callDecision(mark: TurnMark): { callId: string; decision: Decision } | undefined {
  if (mark.kind !== 'outcome' || !mark.callId) return undefined;
  const label = sanitizeTerminalText(mark.label, { singleLine: true }).trim();
  return { callId: mark.callId, decision: { kind: mark.outcome, label } };
}

/** The one rank every row of a saved turn is drawn by: its calls and its
 * marks, in (responseOffset, seq) order (standard 1.3, orderMarks).
 *
 * Where every row carries the worker's `seq` it decides ties. A turn saved
 * before they were kept has none on its calls, and its marks cannot be placed
 * among them by a number that is not comparable -- so then NO seq is used,
 * and the turn reads in the order it was recorded: by offset, calls first
 * (the local counter is only the fallback, never mixed with the worker's). */
export function savedTurnRanks(
  activities: ReadonlyArray<Pick<TurnActivity, 'responseOffset'> & { event: { seq?: number } }>, marks: readonly TurnMark[],
  /** False when some mark's seq is not the worker's (a row learned of by
   * another route): then no seq is used at all. */
  options: { marksHaveSeq?: boolean } = {},
): { activities: number[]; marks: number[] } {
  const bySeq = options.marksHaveSeq !== false && activities.every((activity) => activity.event.seq !== undefined);
  const rows = [
    ...activities.map((activity, index) => ({ kind: 'a' as const, index, responseOffset: activity.responseOffset, ...(bySeq ? { seq: activity.event.seq! } : {}) })),
    ...marks.map((mark, index) => ({ kind: 'm' as const, index, responseOffset: mark.responseOffset, ...(bySeq ? { seq: mark.seq } : {}) })),
  ];
  const result = { activities: new Array<number>(activities.length).fill(0), marks: new Array<number>(marks.length).fill(0) };
  for (const [rank, row] of orderMarks(rows, (item) => ({ responseOffset: item.responseOffset, ...(item.seq === undefined ? {} : { seq: item.seq }) })).entries()) {
    (row.kind === 'a' ? result.activities : result.marks)[row.index] = rank + 1;
  }
  return result;
}

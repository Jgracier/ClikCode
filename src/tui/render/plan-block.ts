/** The todo block: a harness's plan, windowed around the step in progress. */

import chalk from 'chalk';
import { sanitizeTerminalText } from './text.js';
import { visibleSlice } from './width.js';
import type { HarnessPlanEntry } from '../../harness/events/turn-observer.js';
import { PLAN_MAX_ROWS, planStillNeeded, planWindow } from './plan-window.js';

/** The shared shape, so a plan entry means the same thing whichever harness
 * produced it. Status is compared, never exhaustively matched: a harness may
 * publish anything, and anything unrecognised reads as not-yet-done. */
export type PlanEntry = HarnessPlanEntry;

/** A compact todo block: at most PLAN_MAX_ROWS rows, windowed around the step
 * in progress so a long plan never crowds the conversation out of view. */
export function planBlockRows(
  entries: readonly PlanEntry[], width: number, maxRows = PLAN_MAX_ROWS,
  /** The step in progress animates with the waiting spinner while a turn runs; `◐` otherwise. */
  activeGlyph = '◐',
): string[] {
  if (!planStillNeeded(entries) || maxRows < 1) return [];
  const { visible, done, hidden } = planWindow(entries, maxRows);
  const rows = visible.map(({ entry }) => {
    const text = visibleSlice(sanitizeTerminalText(entry.content, { singleLine: true }).trim(), Math.max(4, width - 6));
    return entry.status === 'completed' ? `  ${chalk.green('☑')} ${chalk.dim(text)}`
      // A two-cell spinner takes one column of the indent, so the text stays aligned with the rows around it.
      : entry.status === 'in_progress' ? `${[...activeGlyph].length > 1 ? ' ' : '  '}${chalk.cyan(activeGlyph)} ${chalk.bold(text)}`
        : entry.status === 'cancelled' ? `  ${chalk.dim('☒')} ${chalk.dim.strikethrough(text)}` : `  ☐ ${text}`;
  });
  if (hidden) rows.push(`  ${chalk.dim(`  ${done}/${entries.length} done · ${hidden} more`)}`);
  return rows;
}

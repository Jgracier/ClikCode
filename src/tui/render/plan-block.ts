/** The todo block: a harness's plan, windowed around the step in progress. */

import chalk from 'chalk';
import { sanitizeTerminalText, visibleSlice } from './markdown.js';
import type { HarnessPlanEntry } from '../../harness/events/turn-observer.js';

/** The shared shape, so a plan entry means the same thing whichever harness
 * produced it. Status is compared, never exhaustively matched: a harness may
 * publish anything, and anything unrecognised reads as not-yet-done. */
export type PlanEntry = HarnessPlanEntry;

const PLAN_MAX_ROWS = 6;

/** A compact todo block: at most PLAN_MAX_ROWS rows, windowed around the step
 * in progress so a long plan never crowds the conversation out of view. */
export function planBlockRows(entries: readonly PlanEntry[], width: number, maxRows = PLAN_MAX_ROWS): string[] {
  if (!entries.length || maxRows < 1) return [];
  const done = entries.filter((entry) => entry.status === 'completed').length;
  const capacity = Math.max(1, Math.min(maxRows, PLAN_MAX_ROWS));
  let visible = entries.map((entry, index) => ({ entry, index }));
  if (visible.length > capacity) {
    const active = Math.max(0, entries.findIndex((entry) => entry.status !== 'completed'));
    const start = Math.max(0, Math.min(active - 1, entries.length - (capacity - 1)));
    visible = visible.slice(start, start + capacity - 1);
  }
  const rows = visible.map(({ entry }) => {
    const text = visibleSlice(sanitizeTerminalText(entry.content, { singleLine: true }).trim(), Math.max(4, width - 6));
    return entry.status === 'completed' ? `  ${chalk.green('☑')} ${chalk.dim(text)}`
      : entry.status === 'in_progress' ? `  ${chalk.cyan('◐')} ${chalk.bold(text)}` : `  ☐ ${text}`;
  });
  if (visible.length < entries.length) rows.push(`  ${chalk.dim(`  ${done}/${entries.length} done · ${entries.length - visible.length} more`)}`);
  return rows;
}

/** Two bands of the composer's footer, as rows: the slash palette (or a
 * picker's list) and the scrollable panel. Pure: what to show and how wide
 * in, rows out; the prompter only places them. */

import chalk from 'chalk';
import { paletteDisplayRows, type PaletteEntry } from '../command-palette.js';
import { terminalCellWidth, visibleSlice } from './width.js';
import { wrapCodeLine } from './wrap.js';

/** The palette band, `capacity` rows tall: a rule, the list windowed around
 * the selected row (padded to its height), and the hint under it. `width`
 * is the terminal's. */
export function paletteRows(
  options: readonly PaletteEntry[], selected: number, capacity: number, width: number,
  settings: { headings?: boolean; hint?: string } = {},
): string[] {
  const rows = ['─'.repeat(width - 1)];
  const visibleRows = capacity - 2;
  const windowed = paletteDisplayRows(options, selected, visibleRows);
  for (const row of windowed) {
    if ('header' in row) {
      // A picker's sections read as headings with their size beside them,
      // the way Claude Code's session list does; the command palette keeps
      // its quieter rule.
      const counted = settings.headings ? /^(.*?)(?: (\d+))?$/.exec(row.header) : null;
      rows.push(counted
        ? `  ${chalk.bold(visibleSlice(counted[1] ?? '', Math.max(1, width - 10)))}${counted[2] ? ` ${chalk.dim(counted[2])}` : ''}`
        : `  ${chalk.dim(visibleSlice(`── ${row.header}`, Math.max(1, width - 4)))}`);
      continue;
    }
    const selectedOption = row.index === selected;
    const available = Math.max(1, width - 4);
    const label = visibleSlice(row.option.label, available);
    const remaining = available - terminalCellWidth(label);
    const detail = row.option.detail && remaining > 3 ? visibleSlice(row.option.detail, remaining - 2) : '';
    rows.push(`  ${selectedOption ? chalk.cyan('❯') : ' '} ${selectedOption ? chalk.bold(label) : label}${detail ? `  ${chalk.dim(detail)}` : ''}`);
  }
  for (let index = windowed.length; index < visibleRows; index++) rows.push('');
  rows.push(`  ${chalk.dim(visibleSlice(settings.hint ?? '↑↓ select · Tab complete · Enter run', width - 2))}`);
  return rows;
}

/** An open panel: its title, one page of its body wrapped to `inner`, and a
 * line saying how to scroll and close it. The page fits `budget` rows (two
 * of them the title and that line) and never most of a short screen.
 * `page`, `total` and the clamped `offset` are what its keys scroll by. */
export function panelRows(
  panel: { title: string; lines: readonly string[]; offset: number }, inner: number, budget: number, targetHeight: number,
): { rows: string[]; page: number; total: number; offset: number } {
  const wrapped = panel.lines.flatMap((line) => (terminalCellWidth(line) <= inner ? [line] : wrapCodeLine(line, inner)));
  const page = Math.max(1, Math.min(wrapped.length, budget - 2, Math.max(3, targetHeight - 10)));
  const offset = Math.max(0, Math.min(panel.offset, wrapped.length - page));
  const position = wrapped.length > page ? `${offset + 1}-${offset + page} of ${wrapped.length} · ↑↓ PgUp/PgDn scroll · ` : '';
  return {
    rows: [
      `  ${chalk.bold(visibleSlice(panel.title, inner))}`,
      ...wrapped.slice(offset, offset + page).map((line) => `  ${line}`),
      `  ${chalk.dim(visibleSlice(`${position}q/Esc/Enter close`, inner))}`,
    ],
    page, total: wrapped.length, offset,
  };
}

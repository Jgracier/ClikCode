/** How each tool category looks: its colour, its verb, its glyph, and how a
 * folded run of them reads.
 *
 * Beside ToolCategory rather than in tui/render, because both sides need it:
 * the TUI paints with it and activity-line.ts builds a row with it. It used to
 * live in tui/render/activity-log.ts, which made a protocol module import from
 * tui/ -- a layering inversion that also closed a real import cycle, since
 * activity-log imports renderActivityLine straight back.
 *
 * It is presentation data keyed on a protocol type, so the protocol side is
 * where it belongs and neither consumer has to reach across.
 */

import chalk from 'chalk';
import type { ToolCategory } from '../prompter.js';

export const TOOL_CATEGORY_STYLE: Record<ToolCategory, {
  paint: (text: string) => string; verb: string; glyph: string;
  /** How a folded run of these reads once it has settled. */
  folded: (count: number) => string;
}> = {
  read: { paint: (text) => chalk.blue(text), verb: 'reading', glyph: '◇', folded: (n) => `read ${n} files` },
  edit: { paint: (text) => chalk.magenta(text), verb: 'editing', glyph: '◆', folded: (n) => `edited ${n} files` },
  run: { paint: (text) => chalk.yellow(text), verb: 'running', glyph: '▸', folded: (n) => `ran ${n} commands` },
  search: { paint: (text) => chalk.cyan(text), verb: 'searching', glyph: '◈', folded: (n) => `searched ${n} times` },
  fetch: { paint: (text) => chalk.green(text), verb: 'fetching', glyph: '↓', folded: (n) => `fetched ${n} pages` },
};

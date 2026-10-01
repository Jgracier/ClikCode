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
import { TOOL_CATEGORY } from './tool-category.js';

export const TOOL_CATEGORY_STYLE: Record<ToolCategory, (typeof TOOL_CATEGORY)[ToolCategory] & { paint: (text: string) => string }> =
  Object.fromEntries(Object.entries(TOOL_CATEGORY).map(([category, facts]) => [category, { ...facts, paint: (text: string) => chalk[facts.colour](text) }])) as never;

/** The terminal's painters for the look (look.ts): the only place chalk is
 * given an activity row's colour. Every role is painted from LOOK, so a
 * colour is changed in one file and the webview follows.
 *
 * Beside ToolCategory rather than in tui/render, because both sides need it:
 * the TUI paints with it and activity-line.ts builds a row with it. */

import chalk from 'chalk';
import { LOOK, type LookRole, type LookRoleName } from './look.js';

function painterFor(role: LookRole): (text: string) => string {
  return (text) => {
    let style = role.ansi === undefined ? chalk : chalk.ansi256(role.ansi);
    if (role.dim) style = style.dim;
    if (role.italic) style = style.italic;
    return style(text);
  };
}

/** `look.paint.failed('x')`, `look.paint.thought('✻ Thought for 2s')`, ... */
export const look: { paint: Record<LookRoleName, (text: string) => string> } = {
  paint: Object.fromEntries(Object.entries(LOOK.roles).map(([name, role]) => [name, painterFor(role)])) as never,
};

/** The glyph every tool row starts with, painted. */
export const toolGlyph = (): string => look.paint.toolGlyph(LOOK.glyph.tool);

/** The words of a call's row: a lighter blue than its glyph. */
export const TOOL_ROW_TEXT = (text: string): string => look.paint.toolText(text);

/** The settled thought row, `✻ Thought for 3s · heading`: dim italic. */
export const thoughtLine = (text: string): string => look.paint.thought(`${LOOK.glyph.thought} ${text}`);

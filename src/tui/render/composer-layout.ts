/** The composer's viewport: which rows of a multi-line draft are visible and
 * where the cursor sits in them. */

import { nextCharacterIndex, terminalCellWidth } from './width.js';

export interface ComposerLayout {
  rows: string[];
  cursorRow: number;
  cursorWidth: number;
}

/** Soft-wrap the composer like a normal terminal editor. The old horizontal
 * viewport hid the beginning of long prompts and made typing appear stuck on
 * one line; this preserves the whole nearby draft and exposes a real cursor
 * row for absolute-positioned TUI painting. */
export function composerLayout(value: string, cursor: number, available: number, maxRows = 6): ComposerLayout {
  const width = Math.max(1, available);
  const ranges: Array<{ start: number; end: number }> = [];
  let rowStart = 0;
  let lastWhitespaceStart: number | undefined;
  let lastWhitespaceEnd: number | undefined;
  let previousWasWhitespace = false;
  let column = 0;
  for (let index = 0; index < value.length;) {
    const next = nextCharacterIndex(value, index);
    const character = value.slice(index, next);
    if (character === '\n') {
      ranges.push({ start: rowStart, end: index });
      rowStart = next;
      column = 0;
      lastWhitespaceStart = undefined;
      lastWhitespaceEnd = undefined;
      previousWasWhitespace = false;
      index = next;
      continue;
    }
    const characterWidth = Math.max(1, terminalCellWidth(character));
    if (column > 0 && column + characterWidth > width) {
      if (/\s/u.test(character)) {
        ranges.push({ start: rowStart, end: index });
        rowStart = next;
        index = next;
      } else if (lastWhitespaceStart !== undefined && lastWhitespaceEnd !== undefined && lastWhitespaceEnd > rowStart) {
        ranges.push({ start: rowStart, end: lastWhitespaceStart });
        rowStart = lastWhitespaceEnd;
        index = rowStart;
      } else {
        ranges.push({ start: rowStart, end: index });
        rowStart = index;
      }
      column = 0;
      lastWhitespaceStart = undefined;
      lastWhitespaceEnd = undefined;
      previousWasWhitespace = false;
      continue;
    }
    column += characterWidth;
    if (/\s/u.test(character)) {
      if (!previousWasWhitespace) lastWhitespaceStart = index;
      lastWhitespaceEnd = next;
      previousWasWhitespace = true;
    } else {
      previousWasWhitespace = false;
    }
    index = next;
  }
  ranges.push({ start: rowStart, end: value.length });
  const rows = ranges.map(({ start, end }) => value.slice(start, end));
  let position = { row: Math.max(0, rows.length - 1), column: 0 };
  for (const [row, range] of ranges.entries()) {
    if (cursor < range.start) {
      position = { row, column: 0 };
      break;
    }
    if (cursor > range.end) continue;
    position = { row, column: terminalCellWidth(value.slice(range.start, cursor)) };
    // A soft-wrap boundary belongs to the following row so the cursor does
    // not remain visually stranded at the end of the previous full line.
    if (cursor === range.end && ranges[row + 1]?.start === cursor) continue;
    break;
  }
  const start = Math.max(0, Math.min(position.row - maxRows + 1, rows.length - maxRows));
  const visible = rows.slice(start, start + maxRows);
  return { rows: visible, cursorRow: position.row - start, cursorWidth: position.column };
}

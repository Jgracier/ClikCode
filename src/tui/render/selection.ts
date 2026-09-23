/** Selecting text with the mouse, done by ClikCode itself.
 *
 * ClikCode turns on the terminal's mouse reporting so that swipes and the
 * wheel scroll the conversation -- which also means a drag no longer reaches
 * the terminal's own selection, and select-and-copy stopped working. The
 * terminal still tells ClikCode everything a selection needs: where the
 * button went down, every cell it was dragged through, and where it came up
 * (measured on this user's clients: presses, drags and releases all arrive,
 * phone-sized screens and desktop alike). So ClikCode selects, the way tmux
 * and editors do: the dragged range is highlighted, and on release its text
 * goes to the clipboard -- over SSH too, by OSC 52, the path /copy uses.
 * Scrolling keeps working and there is no mode to switch.
 *
 * Pure: screen rows and mouse reports in, highlighted rows and text out. */
import { displayTokens, terminalCellWidth } from './width.js';

export type Cell = { row: number; col: number };
export type Selection = { anchor: Cell; head: Cell };

export type MouseAction = { kind: 'press' | 'drag' | 'release'; at: Cell };

const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** The left-button press, drag and release in an SGR mouse report, in
 * 0-based screen cells, or undefined for anything else. The wheel (64/65)
 * and bare motion (35) are left to the scroll handling that owns them, and a
 * press held with a modifier (Ctrl is 16, Alt 8, Shift 4) is not a selection:
 * many terminals reserve those for their own. */
export function selectionAction(key: string): MouseAction | undefined {
  const match = SGR_MOUSE.exec(key);
  if (!match) return undefined;
  const button = Number(match[1]);
  const at = { row: Number(match[3]) - 1, col: Number(match[2]) - 1 };
  if (match[4] === 'm') return button === 0 ? { kind: 'release', at } : undefined;
  if (button === 0) return { kind: 'press', at };
  if (button === 32) return { kind: 'drag', at };
  return undefined;
}

/** The two ends in reading order. */
export function orderedRange(selection: Selection): { start: Cell; end: Cell } {
  const { anchor, head } = selection;
  const anchorFirst = anchor.row < head.row || (anchor.row === head.row && anchor.col <= head.col);
  return anchorFirst ? { start: anchor, end: head } : { start: head, end: anchor };
}

/** Whether a drag went anywhere: a click is not a selection. */
export function selectionIsEmpty(selection: Selection): boolean {
  return selection.anchor.row === selection.head.row && selection.anchor.col === selection.head.col;
}

/** The visible cells [from, to] of each selected row, `to` inclusive, or
 * undefined for a row the selection does not touch. Rows in the middle are
 * taken whole, as a terminal's own selection takes them. */
function rowSpan(row: number, range: { start: Cell; end: Cell }): { from: number; to: number } | undefined {
  if (row < range.start.row || row > range.end.row) return undefined;
  return {
    from: row === range.start.row ? range.start.col : 0,
    to: row === range.end.row ? range.end.col : Number.MAX_SAFE_INTEGER,
  };
}

const INVERSE_ON = '\u001b[7m';
const INVERSE_OFF = '\u001b[27m';
const SGR = /^\u001b\[[0-9;]*m$/;

/** One row with its selected cells in inverse video, every other cell and
 * colour exactly as it was. Inverse is re-asserted after any colour change
 * inside the range, since a reset (`ESC[0m`) there would switch it off. */
function highlightRow(value: string, from: number, to: number): string {
  let column = 0;
  let inside = false;
  let result = '';
  for (const token of displayTokens(value)) {
    if (token[0] === '\u001b') {
      result += token;
      if (inside && SGR.test(token)) result += INVERSE_ON;
      continue;
    }
    const width = terminalCellWidth(token);
    const selected = width > 0 && column + width - 1 >= from && column <= to;
    if (selected && !inside) { result += INVERSE_ON; inside = true; }
    if (!selected && inside && width > 0) { result += INVERSE_OFF; inside = false; }
    result += token;
    column += width;
  }
  // A selection reaching past the text on its row still shows as reaching
  // the end: one highlighted cell, the way a terminal marks a line's end.
  if (!inside && to >= column && from <= column && to !== Number.MAX_SAFE_INTEGER) {
    result += `${INVERSE_ON} ${INVERSE_OFF}`;
  } else if (inside) result += INVERSE_OFF;
  return result;
}

export function highlightSelection(rows: readonly string[], selection: Selection): string[] {
  const range = orderedRange(selection);
  return rows.map((row, index) => {
    const span = rowSpan(index, range);
    return span ? highlightRow(row, span.from, span.to) : row;
  });
}

/** The visible text of one row's cells [from, to]. */
function rowText(value: string, from: number, to: number): string {
  let column = 0;
  let text = '';
  for (const token of displayTokens(value)) {
    if (token[0] === '\u001b') continue;
    const width = terminalCellWidth(token);
    if (width > 0 && column + width - 1 >= from && column <= to) text += token;
    column += width;
  }
  return text;
}

/** What a selection copies: the selected cells of each row, trailing blanks
 * dropped (a screen row is padded; the text it shows is not), one line per
 * screen row, and no blank lines at either end. */
export function selectedText(rows: readonly string[], selection: Selection): string {
  const range = orderedRange(selection);
  const lines: string[] = [];
  for (let index = range.start.row; index <= range.end.row && index < rows.length; index += 1) {
    const span = rowSpan(index, range)!;
    lines.push(rowText(rows[index] ?? '', span.from, span.to).replace(/\s+$/, ''));
  }
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.join('\n');
}

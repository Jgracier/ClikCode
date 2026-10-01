import { describe, expect, it } from 'vitest';
import { highlightSelection, lineAtRow, lineText, scrollShift, selectedText, selectionAction, selectionIsEmpty, shiftedRow } from './selection.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const rows = [
  '  \u001b[36mHello\u001b[39m there, all good.   ',
  '  The final commit is live.',
  '',
  '  ─────────',
];

describe('mouse reports that make a selection', () => {
  it('reads a left press, drag and release, in 0-based cells', () => {
    expect(selectionAction('\u001b[<0;10;3M')).toEqual({ kind: 'press', at: { row: 2, col: 9 } });
    expect(selectionAction('\u001b[<32;12;3M')).toEqual({ kind: 'drag', at: { row: 2, col: 11 } });
    expect(selectionAction('\u001b[<0;12;3m')).toEqual({ kind: 'release', at: { row: 2, col: 11 } });
  });

  it('leaves the wheel, bare motion and modified presses alone', () => {
    // The wheel scrolls; motion is hover; a modifier is the terminal's own.
    for (const key of ['\u001b[<64;1;1M', '\u001b[<65;1;1M', '\u001b[<35;5;5M', '\u001b[<16;5;5M', '\u001b[<2;5;5M']) {
      expect(selectionAction(key), key).toBeUndefined();
    }
  });

  it('is not a selection when the button never moved', () => {
    expect(selectionIsEmpty({ anchor: { row: 1, col: 4 }, head: { row: 1, col: 4 } })).toBe(true);
  });
});

describe('the text a selection copies', () => {
  it('is what is shown, colours stripped, within one row', () => {
    expect(selectedText(rows, { anchor: { row: 0, col: 2 }, head: { row: 0, col: 12 } })).toBe('Hello there');
  });

  it('spans rows the way a terminal selection does, in either drag direction', () => {
    const forward = selectedText(rows, { anchor: { row: 0, col: 8 }, head: { row: 1, col: 11 } });
    const backward = selectedText(rows, { anchor: { row: 1, col: 11 }, head: { row: 0, col: 8 } });
    expect(forward).toBe('there, all good.\n  The final');
    expect(backward).toBe(forward);
  });

  it('drops the padding at the end of a row, and blank rows at the ends', () => {
    expect(selectedText(rows, { anchor: { row: 0, col: 0 }, head: { row: 2, col: 50 } }))
      .toBe('  Hello there, all good.\n  The final commit is live.');
  });

  it('counts a wide character as the two cells it fills', () => {
    const wide = ['  你好 world'];
    // 你 fills cells 2-3, 好 4-5, then a space, then "world" from 7.
    expect(selectedText(wide, { anchor: { row: 0, col: 4 }, head: { row: 0, col: 11 } })).toBe('好 world');
  });
});

describe('the highlight', () => {
  it('marks only the selected cells and keeps every colour', () => {
    const [first] = highlightSelection(rows, { anchor: { row: 0, col: 2 }, head: { row: 0, col: 6 } });
    expect(plain(first!)).toBe(plain(rows[0]!));
    expect(first).toContain('\u001b[36m');
    expect(first).toMatch(/\u001b\[7m.*Hello.*\u001b\[27m/);
  });

  it('survives a colour reset inside the range', () => {
    const [first] = highlightSelection(rows, { anchor: { row: 0, col: 2 }, head: { row: 0, col: 12 } });
    // The reset after "Hello" is followed by inverse again, so "there" stays marked.
    expect(first).toContain('\u001b[39m\u001b[7m');
  });

  it('leaves rows outside the selection untouched', () => {
    const highlighted = highlightSelection(rows, { anchor: { row: 0, col: 0 }, head: { row: 0, col: 3 } });
    expect(highlighted.slice(1)).toEqual(rows.slice(1));
  });
});

describe('a selection kept in conversation lines', () => {
  it('highlights the lines it covers wherever they are on screen', async () => {
    const { highlightSelectionAt } = await import('./selection');
    // Screen rows 0..2 show lines 41..43 after the view scrolled; the
    // selection began on line 40, now off screen above.
    const rows = ['alpha', 'bravo', 'charlie'];
    const out = highlightSelectionAt(rows, [41, 42, 43], { anchor: { row: 40, col: 2 }, head: { row: 42, col: 1 } });
    expect(out[0]).toContain('\u001b[7m');
    expect(out[1]).toContain('\u001b[7m');
    expect(out[2]).toBe('charlie');
    // Blank rows above a short transcript show no line.
    expect(highlightSelectionAt(['', 'x'], [Number.NEGATIVE_INFINITY, 0], { anchor: { row: 0, col: 0 }, head: { row: 0, col: 0 } })[0]).toBe('');
  });
});

describe('screen rows and conversation lines', () => {
  it('numbers a row by the line it shows, scrolled, trimmed, short, or live', () => {
    // 10 kept rows (5 trimmed before them), 4 rows of transcript on screen.
    const view = { length: 10, trimmed: 5, above: 4, scrollback: 0 };
    expect([0, 3, 4, 5].map((row) => lineAtRow(view, row))).toEqual([11, 14, 15, 16]);
    expect(lineAtRow({ ...view, scrollback: 3 }, 0)).toBe(8);
    // A transcript shorter than its rows sits at the bottom, blanks above.
    expect(lineAtRow({ length: 2, trimmed: 0, above: 4, scrollback: 0 }, 1)).toBe(Number.NEGATIVE_INFINITY);
    expect(lineAtRow({ length: 2, trimmed: 0, above: 4, scrollback: 0 }, 2)).toBe(0);
  });

  it('reads a line from the transcript or the live rows, and nothing once trimmed', () => {
    const transcript = ['a', 'b'];
    expect([4, 5, 6, 7, 9].map((line) => lineText(line, transcript, 5, ['live']))).toEqual(['', 'a', 'b', 'live', '']);
  });
});

describe('a scroll as a shift', () => {
  const before = ['1', '2', '3', '4', '5', '6', 'composer'];

  it('finds how far the transcript moved, either way', () => {
    expect(scrollShift(before, ['3', '4', '5', '6', '7', '8', 'composer'], 6)).toBe(2);
    expect(scrollShift(before, ['x', 'y', 'z', '1', '2', '3', 'composer'], 6)).toBe(-3);
    expect(shiftedRow(before, 0, 2)).toBe('3');
    expect(shiftedRow(before, 0, -1)).toBeUndefined();
  });

  it('sees no shift in a keystroke, a short transcript or a resize', () => {
    expect(scrollShift(before, ['1', '2', '3', '4', '5', 'X', 'composer'], 6)).toBe(0);
    expect(scrollShift(before.slice(0, 4), ['2', '3', '4', 'x'], 3)).toBe(0);
    expect(scrollShift(before, before.slice(1), 6)).toBe(0);
  });
});

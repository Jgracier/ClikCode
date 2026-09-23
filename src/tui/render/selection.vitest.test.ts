import { describe, expect, it } from 'vitest';
import { highlightSelection, selectedText, selectionAction, selectionIsEmpty } from './selection.js';

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

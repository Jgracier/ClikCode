import { describe, expect, it } from 'vitest';
import { stripAnsi, terminalCellWidth, visiblePathTail } from './width.js';

describe('terminalCellWidth', () => {
  it('measures plain text on the fast path the same as the full one', () => {
    expect(terminalCellWidth('hello — world… │─•')).toBe(18);
    expect(terminalCellWidth('\u001b[1mbold\u001b[22m')).toBe(4);
    expect(terminalCellWidth('a\tb')).toBe(5);
    expect(terminalCellWidth('café')).toBe(4);
  });

  it('sends anything that can join or widen to the full path', () => {
    expect(terminalCellWidth('é')).toBe(1);
    expect(terminalCellWidth('中文')).toBe(4);
    expect(terminalCellWidth('👍🏽')).toBe(2);
    expect(terminalCellWidth('1️⃣')).toBe(2);
    expect(terminalCellWidth('☑️')).toBe(2);
    expect(terminalCellWidth('❤︎')).toBe(1);
  });

  it('gives control characters no cell, CRLF included', () => {
    expect(terminalCellWidth('a\r\nb')).toBe(2);
    expect(terminalCellWidth('中\r\n')).toBe(2);
  });
});

describe('fullwidth and compatibility forms', () => {
  it('are two cells, and their neighbours one', () => {
    expect(terminalCellWidth('\uff21')).toBe(2); // fullwidth A
    expect(terminalCellWidth('\uff01\uff10')).toBe(4); // ! and 0
    expect(terminalCellWidth('\uff5e')).toBe(2);
    expect(terminalCellWidth('\uff60')).toBe(2);
    expect(terminalCellWidth('\uffe0\uffe6')).toBe(4); // cent sign .. won sign
    expect(terminalCellWidth('\ufe30\ufe50')).toBe(4);
    expect(terminalCellWidth('\ufe6b')).toBe(2);
    // Halfwidth forms and the ASCII-adjacent block edges stay one cell.
    expect(terminalCellWidth('\uff61')).toBe(1);
    expect(terminalCellWidth('\uff71')).toBe(1);
    expect(terminalCellWidth('\uffe8')).toBe(1);
    expect(terminalCellWidth('\ufe20')).toBe(0);
    expect(terminalCellWidth('a\uff21b')).toBe(4);
  });
});

describe('a path cut to fit', () => {
  it('drops leading folders, keeping the last one whole', () => {
    expect(visiblePathTail('~/projects/clikcode', 40)).toBe('~/projects/clikcode');
    expect(visiblePathTail('~/projects/clikcode', 12)).toBe('…/clikcode');
    expect(visiblePathTail('~/projects/clikcode', 16)).toBe('…/clikcode');
    expect(visiblePathTail('~/a/projects/clikcode', 20)).toBe('…/projects/clikcode');
  });
});

describe('stripAnsi', () => {
  it('drops colour, OSC 8 links (ST or BEL) and cursor moves, keeping the text', () => {
    expect(stripAnsi('\u001b[1;32mok\u001b[0m')).toBe('ok');
    expect(stripAnsi('\u001b]8;;https://x.dev\u001b\\link\u001b]8;;\u001b\\')).toBe('link');
    expect(stripAnsi('\u001b]8;;https://x.dev\u0007link\u001b]8;;\u0007')).toBe('link');
    expect(stripAnsi('a\u001b[2Kb\u001b[?25lc')).toBe('abc');
    expect(stripAnsi('plain')).toBe('plain');
  });
});

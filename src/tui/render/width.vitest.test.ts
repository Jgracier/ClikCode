import { describe, expect, it } from 'vitest';
import { terminalCellWidth, visiblePathTail } from './width.js';

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

describe('a path cut to fit', () => {
  it('drops leading folders, keeping the last one whole', () => {
    expect(visiblePathTail('~/projects/clikcode', 40)).toBe('~/projects/clikcode');
    expect(visiblePathTail('~/projects/clikcode', 12)).toBe('…/clikcode');
    expect(visiblePathTail('~/projects/clikcode', 16)).toBe('…/clikcode');
    expect(visiblePathTail('~/a/projects/clikcode', 20)).toBe('…/projects/clikcode');
  });
});

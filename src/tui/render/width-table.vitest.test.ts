/** The width table agrees with the phone page's (ClikDeployMobile src/features/terminal/page/unicode.js) where they overlap. */
import { describe, expect, it } from 'vitest';
import { terminalCellWidth } from './width.js';

const w = (code: number): number => terminalCellWidth(String.fromCodePoint(code));

describe('cells', () => {
  it('format characters draw nothing', () => {
    for (const code of [0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0xfeff, 0xe0041]) expect(w(code), code.toString(16)).toBe(0);
    expect(terminalCellWidth('a​b­c')).toBe(3);
    expect(terminalCellWidth('日‏本')).toBe(4);
  });

  it('a prepended format character is the base of a cluster that has width', () => {
    expect(terminalCellWidth('؀١')).toBeGreaterThan(0);
  });

  it('kana supplements, Tangut, Hangul jamo extended-A and the enclosed ideographs are wide', () => {
    for (const code of [0x1b000, 0x1b150, 0x1b2fb, 0x17000, 0x18aff, 0xa960, 0xa97c, 0x1f200, 0x1f202, 0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f260, 0xfe10, 0xfe19]) {
      expect(w(code), code.toString(16)).toBe(2);
    }
  });

  it('the Yijing hexagrams and U+303F are narrow, their neighbours still wide', () => {
    for (const code of [0x4dc0, 0x4dff, 0x303f]) expect(w(code), code.toString(16)).toBe(1);
    for (const code of [0x4dbf, 0x4e00, 0x303e, 0x3041]) expect(w(code), code.toString(16)).toBe(2);
  });
});

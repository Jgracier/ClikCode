import { describe, expect, it } from 'vitest';
import { middleSlice, noticeLines, wrapCodeLine, wrapWords, wrapWordsLive } from './wrap.js';

describe('wrapWordsLive', () => {
  it('gives wrapWords\' lines at every step of a growing text', () => {
    const text = 'The quick brown fox jumps over the lazy dog, \u001b[1mbold words\u001b[22m and a supercalifragilisticexpialidocious word, then 中文 too.';
    for (let at = 1; at <= text.length; at += 1) {
      const step = text.slice(0, at);
      if (/\u001b(\[[0-9;]*)?$/.test(step)) continue;
      expect(wrapWordsLive(step, 12)).toEqual(wrapWords(step, 12));
    }
  });

  it('wraps again from the start when the last line\'s first word changed', () => {
    wrapWordsLive('aaaa **bb', 6);
    expect(wrapWordsLive('aaaa \u001b[1mbb\u001b[22m', 6)).toEqual(wrapWords('aaaa \u001b[1mbb\u001b[22m', 6));
  });
});

describe('hard breaks', () => {
  it('cut a long line in one pass, never inside a cluster or an SGR', () => {
    expect(wrapCodeLine('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
    expect(wrapCodeLine('a中b', 1)).toEqual(['a', '中', 'b']);
    expect(wrapWords('\u001b[1mabcdef\u001b[22m', 4)).toEqual(['\u001b[1mabcd', 'ef\u001b[22m']);
  });
});

describe('a notice above the composer', () => {
  it('wraps to up to three rows, the last ending in … when more was cut', () => {
    const text = 'unknown model nosuch-model; choose one of grok-4, grok-4-fast, grok-3, grok-3-mini, grok-code-fast, grok-2, grok-beta, grok-vision';
    const rows = noticeLines(text, 30);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.length <= 30)).toBe(true);
    expect(rows[2]!.endsWith('…')).toBe(true);
    expect(noticeLines('Stopped', 30)).toEqual(['Stopped']);
  });

  it('shortens a path too long for a row in the middle, keeping its file name', () => {
    const path = '~/projects/a/very/deep/folder/tree/that/goes/on/transcript.md';
    expect(middleSlice(path, 30)).toHaveLength(30);
    expect(middleSlice(path, 30).endsWith('transcript.md')).toBe(true);
    expect(middleSlice(path, 30).startsWith('~/projects')).toBe(true);
    expect(noticeLines(`Transcript written to ${path}`, 30).join(' ')).toContain('transcript.md');
  });
});

import { describe, expect, it } from 'vitest';
import { wrapCodeLine, wrapWords, wrapWordsLive } from './wrap.js';

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

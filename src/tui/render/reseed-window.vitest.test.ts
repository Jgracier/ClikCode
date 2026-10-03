import { describe, expect, it } from 'vitest';
import { reseedStartIndex } from './reseed-window.js';

describe('reseedStartIndex', () => {
  it('starts at 0 when the list fits the budget', () => {
    const messages = [
      { content: 'hi' },
      { content: 'hello' },
    ];
    expect(reseedStartIndex(messages, 100, 80)).toBe(0);
  });

  it('skips early messages when the tail fills the budget', () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      content: `message ${index} ${'x'.repeat(200)}`,
    }));
    const from = reseedStartIndex(messages, 40, 80);
    expect(from).toBeGreaterThan(0);
    expect(from).toBeLessThan(messages.length);
  });

  it('returns 0 for an empty list', () => {
    expect(reseedStartIndex([], 80, 80)).toBe(0);
  });

  it('counts rows at the real width, so a narrow screen reaches back as far as the budget allows', () => {
    // A long last answer: about 52 rows at 80 columns, 102 at 40. With room
    // for 60, the prompt before it fits at 80 but not at 40 -- and the cap the
    // transcript actually keeps holds both at either width.
    const messages = [{ content: 'the question' }, { content: 'y'.repeat(4000) }];
    expect(reseedStartIndex(messages, 60, 80)).toBe(0);
    expect(reseedStartIndex(messages, 60, 40)).toBe(1);
    expect(reseedStartIndex(messages, 2000, 40)).toBe(0);
  });
});

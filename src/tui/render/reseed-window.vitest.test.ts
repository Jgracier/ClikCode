import { describe, expect, it } from 'vitest';
import { reseedStartIndex } from './reseed-window.js';

describe('reseedStartIndex', () => {
  it('starts at 0 when the list fits the budget', () => {
    const messages = [
      { content: 'hi' },
      { content: 'hello' },
    ];
    expect(reseedStartIndex(messages, 100)).toBe(0);
  });

  it('skips early messages when the tail fills the budget', () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      content: `message ${index} ${'x'.repeat(200)}`,
    }));
    const from = reseedStartIndex(messages, 40);
    expect(from).toBeGreaterThan(0);
    expect(from).toBeLessThan(messages.length);
  });

  it('returns 0 for an empty list', () => {
    expect(reseedStartIndex([], 80)).toBe(0);
  });
});

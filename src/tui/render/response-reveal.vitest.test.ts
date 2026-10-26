import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResponseReveal } from './response-reveal.js';

describe('ResponseReveal', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows a few words at once, so a streaming model is not slowed', () => {
    const reveal = new ResponseReveal(() => undefined);
    reveal.update(20);
    expect(reveal.pending).toBe(false);
    expect(reveal.shown('x'.repeat(20))).toHaveLength(20);
  });

  it('eases a burst out over a moment, painting as it goes, and says when it is all shown', () => {
    let paints = 0;
    const reveal = new ResponseReveal(() => { paints += 1; });
    const answer = 'word '.repeat(600);
    let done = false;
    reveal.update(answer.length);
    expect(reveal.pending).toBe(true);
    expect(reveal.shown(answer).length).toBeLessThan(answer.length);
    reveal.whenRevealed(() => { done = true; });
    vi.advanceTimersByTime(3000);
    expect(done).toBe(true);
    expect(paints).toBeGreaterThan(5);
    expect(reveal.shown(answer)).toBe(answer);
  });

  it('flush shows everything now and releases a waiter', () => {
    const reveal = new ResponseReveal(() => undefined);
    let done = false;
    reveal.update(5000);
    reveal.whenRevealed(() => { done = true; });
    reveal.flush();
    expect(done).toBe(true);
    expect(reveal.pending).toBe(false);
  });
});

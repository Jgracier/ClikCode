import { describe, expect, it } from 'vitest';
import { nextRevealed, revealedPrefix, REVEAL_FRAME_MS, REVEAL_IMMEDIATE_CHARS } from './reveal-pace.js';

describe('nextRevealed', () => {
  it('shows a small backlog at once, so a streaming model is not slowed', () => {
    expect(nextRevealed(100, 100 + REVEAL_IMMEDIATE_CHARS, REVEAL_FRAME_MS)).toBe(100 + REVEAL_IMMEDIATE_CHARS);
  });
  it('eases a burst out and has all of it shown in about a second and a half', () => {
    let shown = 0;
    let frames = 0;
    while (shown < 4000 && frames < 1000) { shown = nextRevealed(shown, 4000, REVEAL_FRAME_MS); frames += 1; }
    expect(shown).toBe(4000);
    expect(frames * REVEAL_FRAME_MS).toBeLessThan(2000);
    expect(frames).toBeGreaterThan(10);
  });
  it('always moves forward', () => {
    expect(nextRevealed(0, 5000, 0)).toBeGreaterThan(0);
  });
});

describe('revealedPrefix', () => {
  it('does not split a surrogate pair', () => {
    expect(revealedPrefix('a😀b', 2)).toBe('a');
    expect(revealedPrefix('a😀b', 3)).toBe('a😀');
    expect(revealedPrefix('abc', 10)).toBe('abc');
  });
});

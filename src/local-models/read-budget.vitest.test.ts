import { describe, expect, it } from 'vitest';
import { WORKING_READ_SECONDS, localReadableTokens, readableTokens, READING_SLOWDOWN_PER_TOKEN } from './read-budget.js';

/** The seconds it takes to read `n` tokens at `speed` on an empty context, slowing as it fills. */
const secondsToRead = (n: number, speed: number): number => (n + READING_SLOWDOWN_PER_TOKEN * n * n / 2) / speed;

describe('the tokens a local model can read in a stated time', () => {
  it('reads out in the time it was asked for, whatever the speed', () => {
    for (const speed of [50, 150, 432, 2_000]) {
      const n = readableTokens(speed, WORKING_READ_SECONDS);
      expect(secondsToRead(n, speed)).toBeLessThanOrEqual(WORKING_READ_SECONDS);
      expect(secondsToRead(n + 50, speed)).toBeGreaterThan(WORKING_READ_SECONDS - 1);
    }
  });

  it('is far below the window the server was started with: this machine, qwen3.5-4b, measured 432 tokens/s', () => {
    const n = readableTokens(432);
    // About 25K tokens in two minutes, where half of a 256K window is 131K: the 157K-token first read took 25 minutes or more.
    expect(n).toBeGreaterThan(20_000);
    expect(n).toBeLessThan(30_000);
    expect(secondsToRead(131_072, 432) / 60).toBeGreaterThan(20);
  });

  it('is more for a faster model and for a longer wait, and nothing for no speed or no time', () => {
    expect(readableTokens(1_000)).toBeGreaterThan(readableTokens(100));
    expect(readableTokens(432, 120)).toBeGreaterThan(readableTokens(432, 60));
    expect(readableTokens(0)).toBe(0);
    expect(readableTokens(432, 0)).toBe(0);
  });

  it('is no bound for a model whose speed was never measured: a real start always measures, so that is a failed lookup', () => {
    expect(localReadableTokens(undefined)).toBeUndefined();
    expect(localReadableTokens(0)).toBeUndefined();
    expect(localReadableTokens(432)).toBe(readableTokens(432));
  });
});

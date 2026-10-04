import { describe, expect, it } from 'vitest';
import { estimatedTokens, formatTurnUsage } from './usage-line';

describe('the turn usage line', () => {
  it('shows a percentage-only context and a credit cost (Kiro)', () => {
    expect(formatTurnUsage({ contextPercent: 1.232, credits: 0.0287 })).toBe('1.2% context · 0.029 credits');
    expect(formatTurnUsage({ contextUsed: 9000, contextWindow: 200_000, contextPercent: 4.5 })).toBe('9.0k/200k context');
  });

  it('is empty until the harness reports something', () => {
    expect(formatTurnUsage()).toBe('');
    expect(formatTurnUsage({})).toBe('');
  });

  it('shows tokens, cache hits, where the context stands and cost, each once known', () => {
    // The real Claude turn in claude-partial-messages.jsonl.
    expect(formatTurnUsage({ input: 18, output: 164, cacheRead: 37_010, cacheWrite: 9_580, contextUsed: 23_444, contextWindow: 200_000, costUsd: 0.023699 }))
      .toBe('↑ 18 ↓ 164 tokens · 37k cached · 23k/200k context · $0.02');
    expect(formatTurnUsage({ contextUsed: 12_000 })).toBe('12k context');
    expect(formatTurnUsage({ input: 1_200, output: 30, costUsd: 0.0042 })).toBe('↑ 1.2k ↓ 30 tokens · $0.0042');
  });

  it('estimates output tokens from the stream until the vendor counts them', () => {
    expect(estimatedTokens(401)).toBe(101);
    expect(formatTurnUsage(undefined, 340)).toBe('↓ ~340 tokens');
    expect(formatTurnUsage({ input: 1200, output: 300 }, 40)).toBe('↑ 1.2k ↓ ~340 tokens');
  });
});

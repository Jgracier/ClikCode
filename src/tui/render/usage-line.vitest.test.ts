import { describe, expect, it } from 'vitest';
import { formatTurnUsage } from './usage-line';

describe('the turn usage line', () => {
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
});

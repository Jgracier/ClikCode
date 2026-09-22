import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_WINDOWS, MIN_HITS, costInWindow, learnedUsageReading, learnedWindows,
  recordAllowed, recordRefused, turnCost, type UsageLearning,
} from './usage-learning.js';
import type { HarnessState } from '../../session/model.js';

type Invocation = HarnessState['invocations'][number];
const HOUR = 3_600_000;
const T0 = Date.parse('2026-09-01T00:00:00.000Z');

const turn = (minutesAgoFromT0: number, totalTokens: number, model = 'm1', accountId = 'acct'): Invocation => ({
  id: `i${minutesAgoFromT0}-${totalTokens}`, accountId, provider: 'p', model,
  at: new Date(T0 + minutesAgoFromT0 * 60_000).toISOString(), latencyMs: 1000, totalTokens,
});

describe('turn cost falls back so every harness can learn something', () => {
  it('uses tokens when the harness reports them', () => {
    expect(turnCost(turn(0, 1000))).toBe(1000);
  });
  it('applies a per-model weight', () => {
    expect(turnCost(turn(0, 1000, 'opus'), { opus: 9 })).toBe(9000);
  });
  it('sums the parts when there is no total', () => {
    expect(turnCost({ ...turn(0, 0), totalTokens: undefined, inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 })).toBe(17);
  });
  it('falls back to latency for a text-only harness that reports no tokens', () => {
    // aider, copilot, hermes and cn are parser=text and will never report a
    // token. A limit measured in turn-work is still learnable.
    expect(turnCost({ ...turn(0, 0), totalTokens: undefined, latencyMs: 4200 })).toBe(4200);
  });
  it('falls back to counting the turn when there is nothing at all', () => {
    expect(turnCost({ ...turn(0, 0), totalTokens: undefined, latencyMs: undefined })).toBe(1);
  });
});

describe('cost in a rolling window', () => {
  const invocations = [turn(0, 100), turn(30, 200), turn(240, 400), turn(0, 999, 'm1', 'other-acct')];
  it('counts only this account, inside the window', () => {
    // 5h window ending at T0+300min is half-open: (start, end]. The turn at
    // T0+0 sits exactly on the opening edge and has aged out, so 200 + 400
    // count and the other account's 999 never does.
    expect(costInWindow(invocations, 'acct', T0 + 300 * 60_000, 5 * HOUR)).toBe(600);
  });

  it('includes a turn one millisecond inside the opening edge', () => {
    // Pins the boundary so a future change cannot silently start double
    // counting the turn that is ageing out.
    expect(costInWindow([turn(0, 100)], 'acct', T0 + 5 * HOUR - 1, 5 * HOUR)).toBe(100);
    expect(costInWindow([turn(0, 100)], 'acct', T0 + 5 * HOUR, 5 * HOUR)).toBe(0);
  });
  it('drops what has aged out', () => {
    expect(costInWindow(invocations, 'acct', T0 + 300 * 60_000, HOUR)).toBe(0);
  });
});

describe('MATURITY: nothing is published before the limit has been hit enough', () => {
  const invocations = [turn(0, 1_000_000), turn(60, 1_000_000)];

  it('publishes nothing with no learning at all', () => {
    expect(learnedWindows(undefined)).toEqual([]);
    expect(learnedUsageReading(undefined, invocations, 'acct', T0 + 2 * HOUR)).toBeUndefined();
  });

  it('publishes nothing from successes alone, however many', () => {
    // A thousand quiet turns teach nothing about where the ceiling is.
    let learning: UsageLearning | undefined;
    for (let i = 0; i < 50; i += 1) {
      learning = recordAllowed(learning, invocations, 'acct', T0 + i * 60_000);
    }
    expect(learning!.hits).toEqual([]);
    expect(learnedWindows(learning)).toEqual([]);
    expect(learnedUsageReading(learning, invocations, 'acct', T0 + 2 * HOUR)).toBeUndefined();
  });

  it(`publishes nothing after fewer than ${MIN_HITS} refusals`, () => {
    let learning = recordAllowed(undefined, invocations, 'acct', T0 + 90 * 60_000);
    learning = recordRefused(learning, invocations, 'acct', T0 + 91 * 60_000);
    expect(learning.hits).toHaveLength(1);
    expect(learnedWindows(learning)).toEqual([]);
    expect(learnedUsageReading(learning, invocations, 'acct', T0 + 2 * HOUR)).toBeUndefined();
  });
});

describe('ATTRIBUTION: a window that cannot explain the refusals is dropped', () => {
  it('does not credit a short window for a long window\'s refusal', () => {
    // Two refusals that happened when the 5h window held almost nothing:
    // whatever stopped these turns, it was not the 5h cap.
    const learning: UsageLearning = {
      highWater: { '1h': 100, '5h': 1_000_000, '24h': 5_000_000, weekly: 20_000_000 },
      hits: [
        { at: new Date(T0).toISOString(), costs: { '1h': 0, '5h': 1000, '24h': 4_900_000, weekly: 19_900_000 } },
        { at: new Date(T0 + HOUR).toISOString(), costs: { '1h': 0, '5h': 900, '24h': 4_950_000, weekly: 19_950_000 } },
      ],
    };
    const names = learnedWindows(learning).map((w) => w.name);
    expect(names).not.toContain('5h');      // 1000 is nowhere near its 1M mark
    expect(names).toContain('24h');          // 4.9M is ~98% of its 5M mark
    expect(names).toContain('weekly');
  });
});

describe('a mature account reports a percentage AND an exact reset time', () => {
  // Limit ~1000 in a 5h window, hit twice.
  const invocations = [turn(0, 600), turn(60, 400)];
  const learning: UsageLearning = {
    highWater: { '5h': 1000 },
    hits: [
      { at: new Date(T0 + 120 * 60_000).toISOString(), costs: { '5h': 1000 } },
      { at: new Date(T0 + 180 * 60_000).toISOString(), costs: { '5h': 980 } },
    ],
  };

  it('reports used percentage against the learned limit', () => {
    const now = T0 + 120 * 60_000;
    const reading = learnedUsageReading(learning, invocations, 'acct', now);
    expect(reading?.windows).toHaveLength(1);
    expect(reading?.windows[0]).toMatchObject({ name: '5h', usedPct: 100 });
    expect(reading?.label).toBe('5h 0% left');
  });

  it('computes the reset time exactly, not by estimate', () => {
    // The oldest turn still inside the window ages out at its own timestamp
    // plus the window length. That is arithmetic, so it is exact.
    const now = T0 + 120 * 60_000;
    const reading = learnedUsageReading(learning, invocations, 'acct', now);
    expect(reading?.windows[0]?.resetsAt).toBe(new Date(T0 + 5 * HOUR).toISOString());
  });

  it('shows partial use as a partial percentage', () => {
    const now = T0 + 90 * 60_000;
    const only = learnedUsageReading(learning, [turn(60, 400)], 'acct', now);
    expect(only?.windows[0]?.usedPct).toBe(40);
    expect(only?.label).toBe('5h 60% left');
  });
});

describe('the high-water mark only ever rises', () => {
  it('never learns a limit downward', () => {
    let learning = recordAllowed(undefined, [turn(0, 5000)], 'acct', T0);
    const high = learning.highWater['5h'];
    learning = recordAllowed(learning, [turn(0, 10)], 'acct', T0 + 10 * HOUR);
    expect(learning.highWater['5h']).toBe(high);
  });
});

describe('the candidate window set is the standard vendor set', () => {
  it('offers 1h, 5h, 24h and weekly', () => {
    expect(CANDIDATE_WINDOWS.map((w) => w.name)).toEqual(['1h', '5h', '24h', 'weekly']);
  });
});

describe('reported cost is preferred over token counts', () => {
  const base: Invocation = {
    id: 'c1', accountId: 'acct', provider: 'anthropic', model: 'opus',
    at: new Date(T0).toISOString(), latencyMs: 1000,
  };

  it('uses costUsd when the vendor reports it', () => {
    // A dollar figure already encodes the model's price and the vendor's
    // cache discount, so it needs no per-model weight.
    expect(turnCost({ ...base, costUsd: 0.25 })).toBe(250_000);
  });

  it('ignores a per-model weight when cost is reported', () => {
    // Weighting a dollar figure by a model multiplier would double-count the
    // model's price, which is already in the dollars.
    expect(turnCost({ ...base, costUsd: 0.25 }, { opus: 9 })).toBe(250_000);
  });

  it('prefers cost even when token fields are also present', () => {
    // This is the real Claude shape: input 2, cache_read 10118, output 60,
    // and a cost. Scoring it by tokens would treat a heavily cached turn as
    // if it were fresh work.
    expect(turnCost({ ...base, inputTokens: 2, outputTokens: 60, cacheReadTokens: 10118, costUsd: 0.2758295 }))
      .toBe(275_829.5);
  });

  it('falls back to summed tokens when no cost is reported', () => {
    expect(turnCost({ ...base, inputTokens: 2, outputTokens: 60, cacheReadTokens: 10118 })).toBe(10_180);
  });

  it('treats a zero cost as absent rather than as a free turn', () => {
    // A vendor emitting 0.0 is reporting "unknown", not "this was free";
    // taking it literally would make every turn cost nothing and the learned
    // ceiling would never rise.
    expect(turnCost({ ...base, costUsd: 0, totalTokens: 500 })).toBe(500);
  });
});

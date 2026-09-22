import { describe, expect, it } from 'vitest';
import { fitModelWeights, type UsageLearning } from './usage-learning.js';

/**
 * Per-model weights, fitted from refusals.
 *
 * A vendor's quota is spent in its own internal unit, and a premium model
 * consumes more of it per token than a cheap one. So a window that hit the
 * limit on mostly-opus traffic shows FEWER tokens than one that hit it on
 * mostly-flash. That difference across refusals with different mixes is the
 * only signal available, and it is what these recover.
 *
 * The truth used below: flash=1, pro=4, opus=9, limit 1,000,000 weighted
 * units. Each hit's token mix is chosen so the weighted total lands on the
 * limit exactly, which is what a real refusal means.
 */
const hit = (at: string, tokensByModel: Record<string, number>): UsageLearning['hits'][number] =>
  ({ at, costs: { '5h': 0 }, tokensByModel });

describe('fitting per-model cost weights', () => {
  it('recovers known weights from refusals with differing model mixes', () => {
    const learning: UsageLearning = {
      highWater: { '5h': 1_000_000 },
      hits: [
        // 1M flash alone
        hit('2026-09-01T00:00:00Z', { flash: 1_000_000 }),
        // 250k pro alone -> 250k x 4 = 1M
        hit('2026-09-01T06:00:00Z', { pro: 250_000 }),
        // 111,111 opus alone -> x9 = 1M
        hit('2026-09-01T12:00:00Z', { opus: 111_111 }),
        // a mix: 400k flash + 100k pro + 22,222 opus = 400k + 400k + 200k = 1M
        hit('2026-09-01T18:00:00Z', { flash: 400_000, pro: 100_000, opus: 22_222 }),
        hit('2026-09-02T00:00:00Z', { flash: 500_000, pro: 125_000 }),
      ],
    };
    const weights = fitModelWeights(learning, '5h');
    expect(Object.keys(weights).sort()).toEqual(['flash', 'opus', 'pro']);
    // Ridge pulls toward 1.0, so exact recovery is not expected -- the
    // ORDERING and rough magnitude are what matter for scheduling.
    expect(weights.flash).toBeGreaterThan(0.5);
    expect(weights.pro).toBeGreaterThan(weights.flash!);
    expect(weights.opus).toBeGreaterThan(weights.pro!);
  });

  it('declines to fit with fewer refusals than models', () => {
    // Two equations cannot place three unknowns, and pretending otherwise is
    // how you get a weight of 400 from one cheap turn.
    const learning: UsageLearning = {
      highWater: { '5h': 1_000_000 },
      hits: [
        hit('2026-09-01T00:00:00Z', { flash: 1_000_000 }),
        hit('2026-09-01T06:00:00Z', { pro: 250_000 }),
        hit('2026-09-01T12:00:00Z', { opus: 111_111 }),
      ],
    };
    expect(fitModelWeights(learning, '5h')).toEqual({});
  });

  it('declines to fit before the minimum number of refusals', () => {
    const learning: UsageLearning = {
      highWater: { '5h': 1_000_000 },
      hits: [hit('2026-09-01T00:00:00Z', { flash: 1_000_000 })],
    };
    expect(fitModelWeights(learning, '5h')).toEqual({});
  });

  it('declines when no limit has been learned for that window', () => {
    const learning: UsageLearning = {
      highWater: {},
      hits: [
        hit('2026-09-01T00:00:00Z', { flash: 1_000_000 }),
        hit('2026-09-01T06:00:00Z', { pro: 250_000 }),
        hit('2026-09-01T12:00:00Z', { opus: 111_111 }),
        hit('2026-09-01T18:00:00Z', { flash: 400_000, pro: 100_000 }),
      ],
    };
    expect(fitModelWeights(learning, '5h')).toEqual({});
  });

  it('declines when every refusal has the same mix, which carries no signal', () => {
    // Identical rows are one equation repeated. A fit here would be inventing
    // a distinction the data does not contain.
    const same = { flash: 500_000, pro: 125_000 };
    const learning: UsageLearning = {
      highWater: { '5h': 1_000_000 },
      hits: [
        hit('2026-09-01T00:00:00Z', same), hit('2026-09-01T06:00:00Z', same),
        hit('2026-09-01T12:00:00Z', same), hit('2026-09-01T18:00:00Z', same),
      ],
    };
    const weights = fitModelWeights(learning, '5h');
    // Either it declines, or the ridge holds both near 1.0 -- what it must
    // NOT do is manufacture a large difference between them.
    if (Object.keys(weights).length) {
      expect(Math.abs((weights.flash ?? 1) - (weights.pro ?? 1))).toBeLessThan(2);
    }
  });

  it('rejects an implausible weight rather than publishing it', () => {
    // A degenerate mix that would imply a model costs hundreds of times more.
    const learning: UsageLearning = {
      highWater: { '5h': 1_000_000 },
      hits: [
        hit('2026-09-01T00:00:00Z', { flash: 1_000_000 }),
        hit('2026-09-01T06:00:00Z', { weird: 1 }),
        hit('2026-09-01T12:00:00Z', { weird: 2 }),
        hit('2026-09-01T18:00:00Z', { weird: 3, flash: 10 }),
        hit('2026-09-02T00:00:00Z', { weird: 4, flash: 20 }),
      ],
    };
    const weights = fitModelWeights(learning, '5h');
    for (const value of Object.values(weights)) {
      expect(value).toBeLessThanOrEqual(25);
      expect(value).toBeGreaterThanOrEqual(0.1);
    }
  });
});

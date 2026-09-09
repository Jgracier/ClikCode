// ============================================
// THROUGHPUT IS COMPARED AGAINST THE POOL, NOT AGAINST A NUMBER FROM 2024
// ============================================
//
// `preferThroughput` asks one question: of the models I could send this
// generation to, which produces fastest. It was answered against a hardcoded
// 50 tok/s, and the adjustment band is 0.8x-1.25x — so the entire range in
// which the signal could say anything was 40-62.5 tok/s.
//
// Every reading this platform collects sits above that. Mainstream hosted
// models generate past 100 tok/s and the endpoint-health feed reports three
// figures routinely (its own fixture carries 117). So every measured candidate
// pinned to the ceiling, and a 400 tok/s model scored exactly the same as a
// 70 tok/s one — the signal was on, was consulted, and separated nothing.
//
// These tests hold the fix: the neutral rate is the pool's own median.

import { describe, expect, it } from 'vitest';

import {
  poolReferenceThroughput,
  rankRouterCandidates,
  type AiRouterCandidate,
} from './ai-router-selection';

function candidate(over: Partial<AiRouterCandidate> = {}): AiRouterCandidate {
  return {
    provider: 'p',
    model: 'm',
    accessClass: 'metered',
    estimatedCostPerMTok: 1,
    avgLatencyMs: 1000,
    arenaScore: 60,
    ...over,
  } as AiRouterCandidate;
}

const order = (pool: AiRouterCandidate[]) =>
  rankRouterCandidates(pool, 'auto', undefined, undefined, { preferThroughput: true }).map(
    (c) => c.model,
  );

describe('the neutral generation rate', () => {
  it('is the median of what the pool was actually measured to produce', () => {
    expect(
      poolReferenceThroughput([
        candidate({ throughputTokensPerSecond: 40 }),
        candidate({ throughputTokensPerSecond: 300 }),
        candidate({ throughputTokensPerSecond: 100 }),
      ]),
    ).toBe(100);
  });

  it('averages the middle pair when the measured count is even', () => {
    expect(
      poolReferenceThroughput([
        candidate({ throughputTokensPerSecond: 40 }),
        candidate({ throughputTokensPerSecond: 100 }),
        candidate({ throughputTokensPerSecond: 120 }),
        candidate({ throughputTokensPerSecond: 300 }),
      ]),
    ).toBe(110);
  });

  it('ignores candidates nobody has measured', () => {
    // "Never generated enough to measure" is not "slow", and letting an
    // unmeasured candidate drag the median would make the reference a fact
    // about coverage rather than about speed.
    expect(
      poolReferenceThroughput([
        candidate({ throughputTokensPerSecond: 100 }),
        candidate({ throughputTokensPerSecond: 200 }),
        candidate({ throughputTokensPerSecond: 300 }),
        candidate({}),
        candidate({}),
      ]),
    ).toBe(200);
  });

  it('counts the external feed, at its own weight, when we have no reading', () => {
    // A pair the aggregator has measured continuously and we never have still
    // belongs in the middle — the fusion precedence is unchanged, only the
    // reference moved.
    expect(
      poolReferenceThroughput([
        candidate({ externalThroughputTps: 90 }),
        candidate({ externalThroughputTps: 150 }),
        candidate({ externalThroughputTps: 210 }),
      ]),
    ).toBe(150);
  });

  it('declines to invent a middle from fewer than three readings', () => {
    // One or two readings compared against themselves describe the sample, not
    // the models. The fixed fallback takes over here, deliberately.
    expect(poolReferenceThroughput([candidate({ throughputTokensPerSecond: 100 })])).toBeNull();
    expect(
      poolReferenceThroughput([
        candidate({ throughputTokensPerSecond: 100 }),
        candidate({ throughputTokensPerSecond: 200 }),
      ]),
    ).toBeNull();
    expect(poolReferenceThroughput([])).toBeNull();
  });
});

describe('ranking a generation-heavy request', () => {
  // THE DEFECT, stated as the ordering it broke. Under a fixed 50 tok/s
  // reference all three of these clip to MAX_THROUGHPUT_FACTOR and the ranking
  // falls through to the alphabetical tiebreak. Names are chosen so that
  // tiebreak produces the WRONG order, or this would pass against the bug.
  it('separates candidates that are all faster than any fixed reference', () => {
    expect(
      order([
        candidate({ model: 'a-slowest', throughputTokensPerSecond: 90 }),
        candidate({ model: 'b-middle', throughputTokensPerSecond: 160 }),
        candidate({ model: 'c-fastest', throughputTokensPerSecond: 400 }),
      ]),
    ).toEqual(['c-fastest', 'b-middle', 'a-slowest']);
  });

  it('still separates candidates that are all slower than any fixed reference', () => {
    // The mirror image: under a fixed 50 these would all pin to the FLOOR.
    // A pool of small local models must still rank its fastest first.
    expect(
      order([
        candidate({ model: 'a-slowest', throughputTokensPerSecond: 4 }),
        candidate({ model: 'z-fastest', throughputTokensPerSecond: 30 }),
        candidate({ model: 'm-middle', throughputTokensPerSecond: 12 }),
      ]),
    ).toEqual(['z-fastest', 'm-middle', 'a-slowest']);
  });

  it('leaves an unmeasured candidate neutral rather than slow', () => {
    // Neutral means exactly the pool's median treatment, so a candidate nobody
    // has timed sits with the middle of the pool and not at the bottom of it.
    const ranked = order([
      candidate({ model: 'a-fast', throughputTokensPerSecond: 400 }),
      candidate({ model: 'b-median', throughputTokensPerSecond: 100 }),
      candidate({ model: 'c-slow', throughputTokensPerSecond: 20 }),
      candidate({ model: 'd-unmeasured' }),
    ]);
    expect(ranked[0]).toBe('a-fast');
    expect(ranked[ranked.length - 1]).toBe('c-slow');
    // Above the genuinely slow one, below the genuinely fast one.
    expect(ranked.indexOf('d-unmeasured')).toBeLessThan(ranked.indexOf('c-slow'));
    expect(ranked.indexOf('d-unmeasured')).toBeGreaterThan(ranked.indexOf('a-fast'));
  });

  it('is untouched when the caller did not ask for throughput', () => {
    // The reference is only computed for generation-heavy work, and speed must
    // not leak into a planner step's ranking through it.
    const ranked = rankRouterCandidates(
      [
        candidate({ model: 'a-slow', throughputTokensPerSecond: 5 }),
        candidate({ model: 'b-fast', throughputTokensPerSecond: 500 }),
        candidate({ model: 'c-mid', throughputTokensPerSecond: 100 }),
      ],
      'auto',
    ).map((c) => c.model);
    expect(ranked).toEqual(['a-slow', 'b-fast', 'c-mid']);
  });
});

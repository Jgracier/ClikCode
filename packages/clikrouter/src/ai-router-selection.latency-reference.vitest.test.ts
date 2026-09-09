// ============================================
// "UNKNOWN IS NOT CONFIRMED BAD" WAS A COMMENT, NOT A BEHAVIOUR
// ============================================
//
// A candidate nobody has routed to yet gets a neutral latency, and the constant
// that supplied it is documented as "deliberately mid-pack": a new model must
// not outrank a proven-fast one for having no data, and must not be punished as
// if it were confirmed slow either.
//
// 3,000ms is not mid-pack. MEASURED against HuggingFace's live router catalog
// on 2026-09-09: 135 models publish a vendor-measured first-token latency,
// median 649ms, maximum 3,458ms. The neutral sat near the 95th percentile of
// what real endpoints do, so "never measured" scored as nearly the slowest
// thing on the table — at the auto family's latency weight of 2, a standing
// ~4.7-point penalty for having no evidence rather than bad evidence.
//
// These tests hold the fix: the neutral is the pool's own median.

import { describe, expect, it } from 'vitest';

import {
  poolReferenceLatency,
  rankRouterCandidates,
  rankRouterCandidatesWithScores,
  type AiRouterCandidate,
} from './ai-router-selection';

function candidate(over: Partial<AiRouterCandidate> = {}): AiRouterCandidate {
  return {
    provider: 'p',
    model: 'm',
    accessClass: 'metered',
    estimatedCostPerMTok: 1,
    arenaScore: 60,
    ...over,
  } as AiRouterCandidate;
}

const order = (pool: AiRouterCandidate[]) =>
  rankRouterCandidates(pool, 'auto').map((c) => c.model);

describe('the neutral latency', () => {
  it('is the median of what the pool was actually measured at', () => {
    expect(
      poolReferenceLatency([
        candidate({ avgLatencyMs: 200 }),
        candidate({ avgLatencyMs: 3000 }),
        candidate({ avgLatencyMs: 650 }),
      ]),
    ).toBe(650);
  });

  it('averages the middle pair when the measured count is even', () => {
    expect(
      poolReferenceLatency([
        candidate({ avgLatencyMs: 200 }),
        candidate({ avgLatencyMs: 600 }),
        candidate({ avgLatencyMs: 800 }),
        candidate({ avgLatencyMs: 3000 }),
      ]),
    ).toBe(700);
  });

  it('counts the external feed when we have no reading of our own', () => {
    // The fusion precedence is untouched — first-party still leads by weight.
    // Only which candidates can contribute a middle changed.
    expect(
      poolReferenceLatency([
        candidate({ externalLatencyMs: 165 }),
        candidate({ externalLatencyMs: 649 }),
        candidate({ externalLatencyMs: 3458 }),
      ]),
    ).toBe(649);
  });

  it('declines to invent a middle from fewer than three readings', () => {
    expect(poolReferenceLatency([candidate({ avgLatencyMs: 500 })])).toBeNull();
    expect(
      poolReferenceLatency([candidate({ avgLatencyMs: 500 }), candidate({ avgLatencyMs: 900 })]),
    ).toBeNull();
    expect(poolReferenceLatency([candidate({})])).toBeNull();
  });
});

describe('a candidate nobody has measured', () => {
  // THE SEMANTIC, pinned directly rather than through an ordering that happens
  // to fall out of it. Written first as a ranking assertion with a wide
  // capability gap, which passed against the bug: 37 arena points is ~46
  // composite points and the latency penalty is ~4.7, so the gap was deciding
  // it and the rule was never tested.
  it('is scored exactly as if it were measured at the pool median', () => {
    const pool = [
      candidate({ model: 'a', avgLatencyMs: 200 }),
      candidate({ model: 'b', avgLatencyMs: 650 }),
      candidate({ model: 'c', avgLatencyMs: 3000 }),
      candidate({ model: 'unmeasured' }),
    ];
    const scored = rankRouterCandidatesWithScores(pool, 'auto');
    const unmeasured = scored.find((sc) => sc.candidate.model === 'unmeasured');
    const atMedian = scored.find((sc) => sc.candidate.model === 'b');
    expect(unmeasured!.latencyMs).toBe(650);
    expect(unmeasured!.latencyMs).toBe(atMedian!.latencyMs);
  });

  it('sits in the middle of the pool, not at the bottom and not at the top', () => {
    // Mid-pack is the whole stated intent, so it is pinned directly rather than
    // through an ordering that happens to fall out of it: an equally capable
    // unmeasured candidate must beat the pool's slow half and lose to its fast
    // half.
    const ranked = order([
      candidate({ model: 'a-quick', avgLatencyMs: 150 }),
      candidate({ model: 'b-quick', avgLatencyMs: 300 }),
      candidate({ model: 'c-unmeasured' }),
      candidate({ model: 'd-slow', avgLatencyMs: 2600 }),
      candidate({ model: 'e-slow', avgLatencyMs: 3400 }),
    ]);
    expect(ranked.indexOf('c-unmeasured')).toBeLessThan(ranked.indexOf('d-slow'));
    expect(ranked.indexOf('c-unmeasured')).toBeLessThan(ranked.indexOf('e-slow'));
    expect(ranked.indexOf('c-unmeasured')).toBeGreaterThan(ranked.indexOf('a-quick'));
    expect(ranked.indexOf('c-unmeasured')).toBeGreaterThan(ranked.indexOf('b-quick'));
  });

  it('still does not outrank a proven-fast peer of equal capability', () => {
    // The other half of the intent, and the reason this is a median rather than
    // an optimistic floor: "never tried" must not become a strategy.
    const ranked = order([
      candidate({ model: 'a-unmeasured' }),
      candidate({ model: 'b-proven-fast', avgLatencyMs: 120 }),
      candidate({ model: 'c-mid', avgLatencyMs: 700 }),
      candidate({ model: 'd-slow', avgLatencyMs: 2900 }),
    ]);
    expect(ranked.indexOf('b-proven-fast')).toBeLessThan(ranked.indexOf('a-unmeasured'));
  });

  it('falls back to the fixed neutral when the pool cannot supply a middle', () => {
    // Two candidates, one measured. There is no median, so behaviour is exactly
    // what it was before this existed: the unmeasured one is scored at 3s and
    // loses to a peer measured faster than that.
    expect(
      order([
        candidate({ model: 'a-unmeasured' }),
        candidate({ model: 'b-measured', avgLatencyMs: 800 }),
      ])[0],
    ).toBe('b-measured');
  });
});

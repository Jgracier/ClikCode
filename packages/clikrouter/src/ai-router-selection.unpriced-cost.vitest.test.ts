// An unknown price must rank a candidate EXPENSIVE, never IMPOSSIBLE.
//
// `costScore` returns 1,000,000 for "no price on file". That is an ORDERING
// device: in the price-sorted comparators it only ever separates two candidates
// already tied on everything that matters, which is exactly right.
//
// The auto family does not sort by price, it BLENDS. Multiplying the sentinel by
// the balanced 0.01 rate is a flat -10,000 against an intelligence term worth at
// most about 125 — an 80x veto produced by arithmetic rather than by a rule,
// invisible in the explain output, and one that silently prevents the cost
// path's own documented policy for unpriced calls from ever running.
//
// The file's own comment identified this hazard, fixed it for subscription and
// free-tier candidates by excluding them from the penalty, and left it firing
// for metered and unknown ones. These tests hold the rest of the fix.

import { describe, expect, it } from 'vitest';

import { rankRouterCandidatesWithScores, type AiRouterCandidate } from './ai-router-selection';

function candidate(over: Partial<AiRouterCandidate> = {}): AiRouterCandidate {
  return {
    provider: 'p',
    model: 'm',
    accessClass: 'metered',
    estimatedCostPerMTok: 10,
    chatCapable: true,
    ...over,
  } as AiRouterCandidate;
}

describe('an unpriced metered candidate', () => {
  it('is still reachable when it is the strongest thing available', () => {
    // A frontier model whose vendor publishes no per-token rate used to lose to
    // ANY priced alternative regardless of the capability gap.
    const [best] = rankRouterCandidatesWithScores(
      [
        candidate({ model: 'unpriced-frontier', estimatedCostPerMTok: null, agenticIndex: 95 }),
        candidate({ model: 'priced-weak', estimatedCostPerMTok: 5, agenticIndex: 20 }),
      ],
      'auto',
    );
    expect(best!.candidate.model).toBe('unpriced-frontier');
  });

  it('is still PENALISED — an unknown price is assumed dear, not free', () => {
    // Two candidates identical but for the price. The priced-cheap one must win,
    // or "unknown" would have become an advantage.
    const [best] = rankRouterCandidatesWithScores(
      [
        candidate({ model: 'unpriced', estimatedCostPerMTok: null, agenticIndex: 60 }),
        candidate({ model: 'priced-cheap', estimatedCostPerMTok: 1, agenticIndex: 60 }),
      ],
      'auto',
    );
    expect(best!.candidate.model).toBe('priced-cheap');
  });

  // THE SEMANTIC, pinned directly rather than through an ordering that happens
  // to fall out of it: an unknown price is treated as the DEAREST thing this
  // platform would really route to, and no worse. Written first as an ordering
  // assertion with a 2-point capability gap, which landed exactly on the
  // crossover and proved nothing — the gap, not the rule, was deciding it.
  it('costs a candidate the same as being the most expensive real option', () => {
    const [unpriced] = rankRouterCandidatesWithScores(
      [candidate({ model: 'unpriced', estimatedCostPerMTok: null, agenticIndex: 60 })],
      'auto',
    );
    const [veryDear] = rankRouterCandidatesWithScores(
      [candidate({ model: 'dear', estimatedCostPerMTok: 250, agenticIndex: 60 })],
      'auto',
    );
    expect(unpriced!.compositeScore).toBeCloseTo(veryDear!.compositeScore!, 6);
  });

  it('does not override a real capability gap', () => {
    // Cost is a light touch in auto BY DESIGN — even the dearest real model
    // loses only a couple of points — so an unknown price must not outweigh a
    // model that is genuinely far better.
    const [best] = rankRouterCandidatesWithScores(
      [
        candidate({ model: 'unpriced', estimatedCostPerMTok: null, agenticIndex: 90 }),
        candidate({ model: 'priced', estimatedCostPerMTok: 2, agenticIndex: 30 }),
      ],
      'auto',
    );
    expect(best!.candidate.model).toBe('unpriced');
  });

  it('applies the same rule to an UNKNOWN access class', () => {
    // 'unknown' shares the penalty branch with 'metered', so it shared the veto.
    // A newly discovered model whose tier has not been resolved yet is exactly
    // the candidate that would have been silently unrouteable.
    const [best] = rankRouterCandidatesWithScores(
      [
        candidate({ model: 'new', accessClass: 'unknown', estimatedCostPerMTok: null, agenticIndex: 90 }),
        candidate({ model: 'old', estimatedCostPerMTok: 5, agenticIndex: 25 }),
      ],
      'auto',
    );
    expect(best!.candidate.model).toBe('new');
  });

  it('leaves a subscription candidate unaffected, as before', () => {
    // Subscription and free-tier never enter the cost penalty at all — that half
    // of the fix was already in place and must stay.
    const [best] = rankRouterCandidatesWithScores(
      [
        candidate({ model: 'sub', accessClass: 'subscription', estimatedCostPerMTok: null, agenticIndex: 70 }),
        candidate({ model: 'metered-cheap', estimatedCostPerMTok: 1, agenticIndex: 70 }),
      ],
      'auto',
    );
    expect(best!.candidate.model).toBe('sub');
  });

  it('still sorts unpriced LAST in budget mode, where the sentinel is an ordering', () => {
    // The sentinel's original purpose is untouched: in a price-sorted
    // comparator, "no price" belongs at the end.
    const ranked = rankRouterCandidatesWithScores(
      [
        candidate({ model: 'unpriced', estimatedCostPerMTok: null }),
        candidate({ model: 'cheap', estimatedCostPerMTok: 1 }),
        candidate({ model: 'dear', estimatedCostPerMTok: 90 }),
      ],
      'budget',
    );
    expect(ranked.map((r) => r.candidate.model)).toEqual(['cheap', 'dear', 'unpriced']);
  });
});

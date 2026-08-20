// Cache-aware cost at RANK time.
//
// Before this, `costScore` read `estimatedCostPerMTok` — input+output summed
// at full price — so every candidate was priced as a cold start. That is wrong
// in a specific and expensive direction for any task that loops: turns 2..N
// serve the stable prefix from cache at roughly a tenth of input, so a model
// with cheap caching is genuinely cheaper than its base rate says, and the
// ranker could pick a nominally cheaper model that bills more over a run.
//
// The rule this file pins: discount ONLY the input side, ONLY the prefix
// slice, and ONLY when every input needed to say so is actually present.

import { describe, expect, it } from 'vitest';
import { effectiveCostPerMTok, type AiRouterCandidate } from './ai-router-selection';

function candidate(over: Partial<AiRouterCandidate> = {}): AiRouterCandidate {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    accessClass: 'metered',
    // 10 in + 40 out = 50
    estimatedCostPerMTok: 50,
    inputCostPerMTok: 10,
    cachedInputCostPerMTok: 1,
    ...over,
  } as AiRouterCandidate;
}

describe('effectiveCostPerMTok', () => {
  it('prices the cacheable slice at the cache-read rate', () => {
    // Half the prompt is stable prefix: input becomes 1*0.5 + 10*0.5 = 5.5,
    // so the total drops from 50 to 45.5 — output untouched.
    const cost = effectiveCostPerMTok(candidate(), {
      cacheablePrefixTokens: 1_000,
      estimatedPromptTokens: 2_000,
    });
    expect(cost).toBeCloseTo(45.5, 6);
  });

  it('never discounts the OUTPUT half', () => {
    // Even with the entire prompt cacheable, the 40 of output stands. A naive
    // implementation that scaled the whole figure would under-price exactly
    // the models with expensive generation.
    const cost = effectiveCostPerMTok(candidate(), {
      cacheablePrefixTokens: 2_000,
      estimatedPromptTokens: 2_000,
    });
    expect(cost).toBeCloseTo(41, 6); // 1 input + 40 output
  });

  it('clamps a prefix larger than the prompt instead of over-discounting', () => {
    // Two numbers that cannot both be right. Treating the fraction as >1 would
    // discount tokens that do not exist and could even go negative.
    const cost = effectiveCostPerMTok(candidate(), {
      cacheablePrefixTokens: 10_000,
      estimatedPromptTokens: 2_000,
    });
    expect(cost).toBeCloseTo(41, 6);
    expect(cost!).toBeGreaterThan(0);
  });

  it('returns the plain estimate when the vendor publishes no cached rate', () => {
    // Absent is not zero. A model with no published cache price must not be
    // ranked as though caching were free on it.
    const cost = effectiveCostPerMTok(candidate({ cachedInputCostPerMTok: null }), {
      cacheablePrefixTokens: 1_000,
      estimatedPromptTokens: 2_000,
    });
    expect(cost).toBe(50);
  });

  it('returns the plain estimate when the caller declares no prefix', () => {
    // A single-shot task passes nothing, and must be priced cold — which is
    // exactly right for it.
    expect(effectiveCostPerMTok(candidate(), {})).toBe(50);
    expect(effectiveCostPerMTok(candidate())).toBe(50);
  });

  it('leaves an unpriced candidate unpriced', () => {
    // null means "no price on file", which is not a cheap price.
    const cost = effectiveCostPerMTok(candidate({ estimatedCostPerMTok: null }), {
      cacheablePrefixTokens: 1_000,
      estimatedPromptTokens: 2_000,
    });
    expect(cost).toBeNull();
  });

  it('never ranks a cached model as cheaper than its cache rate allows', () => {
    // Guards the direction of the arithmetic: the discounted figure must sit
    // between "all input cached" and "no input cached", never outside.
    const all = effectiveCostPerMTok(candidate(), {
      cacheablePrefixTokens: 2_000,
      estimatedPromptTokens: 2_000,
    })!;
    const some = effectiveCostPerMTok(candidate(), {
      cacheablePrefixTokens: 500,
      estimatedPromptTokens: 2_000,
    })!;
    expect(some).toBeGreaterThan(all);
    expect(some).toBeLessThan(50);
  });
});

describe('measured hit rate beats the declared prefix', () => {
  // The production case this precedence exists for. ClikNet sends
  // byte-identical prompts to both, declaring the same 1,500-token prefix, and
  // gets 55.6% from Mistral and 5.1% from SambaNova (measured 2026-08-20).
  // Pricing both off the declared prefix credits them the SAME discount, which
  // over-states SambaNova by roughly a factor of ten.
  const DECLARED = { cacheablePrefixTokens: 1_500, estimatedPromptTokens: 3_000 };

  it('uses the observation instead of the declared fraction', () => {
    // Declared says half the prompt is cacheable; the measurement says 10%.
    const cost = effectiveCostPerMTok(
      candidate({ observedCacheHitRate: 0.1, observedCacheEligibleTokens: 9_735_750 }),
      DECLARED,
    );
    // input = 1*0.1 + 10*0.9 = 9.1, plus 40 output.
    expect(cost).toBeCloseTo(49.1, 6);
    // What the declared fraction alone would have produced.
    expect(cost).not.toBeCloseTo(45.5, 6);
  });

  it('separates two providers the declared fraction would price identically', () => {
    const mistral = effectiveCostPerMTok(
      candidate({ observedCacheHitRate: 0.556, observedCacheEligibleTokens: 41_295_123 }),
      DECLARED,
    )!;
    const sambanova = effectiveCostPerMTok(
      candidate({ observedCacheHitRate: 0.051, observedCacheEligibleTokens: 9_735_750 }),
      DECLARED,
    )!;
    // The one that actually caches must price cheaper. Before this, both
    // returned 45.5 and the router had no way to tell them apart.
    expect(mistral).toBeLessThan(sambanova);
    expect(sambanova - mistral).toBeGreaterThan(4);
  });

  it('ignores an observation too thin to mean anything', () => {
    // A pair with a handful of tokens behind its rate falls back to the
    // declared estimate rather than letting noise drive pricing.
    const cost = effectiveCostPerMTok(
      candidate({ observedCacheHitRate: 0.99, observedCacheEligibleTokens: 500 }),
      DECLARED,
    );
    expect(cost).toBeCloseTo(45.5, 6); // the declared-fraction answer
  });

  it('honours a measured ZERO — that is evidence, not absence', () => {
    // A provider observed at 0% over real volume genuinely does not cache for
    // us. It must be priced at full input, NOT given the declared discount.
    const cost = effectiveCostPerMTok(
      candidate({ observedCacheHitRate: 0, observedCacheEligibleTokens: 5_000_000 }),
      DECLARED,
    );
    expect(cost).toBe(50);
  });

  it('still prices uncached when there is neither an observation nor a prefix', () => {
    const cost = effectiveCostPerMTok(
      candidate({ observedCacheHitRate: 0.9, observedCacheEligibleTokens: 100 }),
      {},
    );
    expect(cost).toBe(50);
  });
});

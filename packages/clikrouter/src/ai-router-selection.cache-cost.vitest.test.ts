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

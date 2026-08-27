import { describe, expect, it } from 'vitest';
import {
  centeredFactor,
  constraintFactor,
  fuseEvidence,
  sampleWeight,
} from './ai-evidence';

describe('fuseEvidence — no single source is the only source', () => {
  it('lets a second source move the result instead of being vetoed', () => {
    // THE RULE. The ranker used strict precedence in four places: whichever
    // source existed first won outright and the rest were discarded. A
    // well-sampled feed could be silenced by one first-party reading.
    const fused = fuseEvidence([
      { value: 100, weight: 2 },
      { value: 400, weight: 1 },
    ]);
    expect(fused).toBe(200);
    expect(fused).not.toBe(100); // not "first source wins"
    expect(fused).not.toBe(250); // not an unweighted mean either
  });

  it('still lets the better-evidenced source lead', () => {
    // Weighting is the point — the old code was not wrong that a first-party
    // measurement is better evidence, only that "better" meant "exclusive".
    const fused = fuseEvidence([
      { value: 100, weight: 9 },
      { value: 200, weight: 1 },
    ])!;
    expect(fused).toBeLessThan(150);
    expect(fused).toBeGreaterThan(100);
  });

  it('ignores absent, non-finite and zero-weight sources', () => {
    expect(
      fuseEvidence([
        { value: null, weight: 5 },
        { value: undefined, weight: 5 },
        { value: Number.NaN, weight: 5 },
        { value: 42, weight: 0 },
        { value: 10, weight: 1 },
      ]),
    ).toBe(10);
  });

  it('returns null when nothing usable was supplied, rather than inventing a default', () => {
    // The neutral value belongs to the caller — burying one here would make two
    // callers with different neutrals silently share the wrong one.
    expect(fuseEvidence([])).toBeNull();
    expect(fuseEvidence([{ value: null, weight: 1 }])).toBeNull();
  });
});

describe('sampleWeight', () => {
  it('scales a first-party reading by how much of it there is', () => {
    // One observation is an anecdote; outright precedence treated it as a
    // measurement. Ramps to full and never past it.
    expect(sampleWeight(0, 20, 2)).toBe(0);
    expect(sampleWeight(10, 20, 2)).toBe(1);
    expect(sampleWeight(20, 20, 2)).toBe(2);
    expect(sampleWeight(2000, 20, 2)).toBe(2);
  });

  it('treats an absent count as no evidence at all', () => {
    expect(sampleWeight(null, 20, 2)).toBe(0);
    expect(sampleWeight(undefined, 20, 2)).toBe(0);
  });
});

describe('centeredFactor — evidence must be able to help, not only hurt', () => {
  const successRate = { expected: 0.9, min: 0.2, max: 1.15 };

  it('scores "as expected" identically to knowing nothing', () => {
    // THE EQUIVALENCE THAT WAS BROKEN. Absence returns 1; so must a measurement
    // that matches expectation. Previously absence returned 1 and ANY
    // measurement returned <= 1, so knowing nothing beat knowing something good.
    expect(centeredFactor(0.9, successRate)).toBeCloseTo(1, 10);
    expect(centeredFactor(null, successRate)).toBe(1);
    expect(centeredFactor(undefined, successRate)).toBe(1);
  });

  it('rewards beating expectation', () => {
    expect(centeredFactor(0.98, successRate)).toBeGreaterThan(1);
    expect(centeredFactor(1, successRate)).toBeCloseTo(1.111, 3);
  });

  it('keeps the OLD severity for a genuinely unreliable model', () => {
    // The previous code was `capability *= rate` — an expected-value discount,
    // which was the correct reading. A ratio-to-expectation stays close to it
    // (0.4/0.9 = 0.444 vs the old 0.40) rather than halving the penalty, which a
    // piecewise ramp centred on the same point silently did.
    expect(centeredFactor(0.4, successRate)).toBeCloseTo(0.444, 3);
    expect(centeredFactor(0, successRate)).toBeCloseTo(0.2, 10);
  });

  it('clamps rather than extrapolating past the stated bounds', () => {
    expect(centeredFactor(5, successRate)).toBeCloseTo(1.15, 10);
    expect(centeredFactor(-5, successRate)).toBeCloseTo(0.2, 10);
  });

  it('refuses to guess when there is no usable expectation to divide by', () => {
    expect(centeredFactor(0.5, { expected: 0, min: 0.5, max: 1.5 })).toBe(1);
    expect(centeredFactor(0.5, { expected: Number.NaN, min: 0.5, max: 1.5 })).toBe(1);
  });
});

describe('constraintFactor — deliberately NOT symmetric', () => {
  const headroom = { comfortable: 0.25, floor: 0.5 };

  it('never pays a bonus for being idle', () => {
    // A provider with 95% of its quota free is not BETTER than one at 60% free,
    // it is merely unconstrained. Rewarding that would rank an unused provider
    // above a proven busy one — which is why this shape exists separately from
    // centeredFactor rather than everything being made symmetric.
    expect(constraintFactor(0.95, headroom)).toBe(1);
    expect(constraintFactor(0.25, headroom)).toBe(1);
  });

  it('discounts proportionally as the quota runs out', () => {
    expect(constraintFactor(0.125, headroom)).toBeCloseTo(0.75, 10);
    expect(constraintFactor(0, headroom)).toBeCloseTo(0.5, 10);
  });

  it('treats unknown headroom as no evidence of pressure', () => {
    expect(constraintFactor(null, headroom)).toBe(1);
    expect(constraintFactor(undefined, headroom)).toBe(1);
  });
});

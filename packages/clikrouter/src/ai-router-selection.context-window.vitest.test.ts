// ============================================
// CONTEXT-WINDOW ELIGIBILITY — the filter that runs BEFORE scoring
// ============================================
// Routing used to be blind to a model's real window: selection ranked on cost
// and latency, and an oversized prompt only met the limit downstream, at the
// prompt shaper, whose only remaining move was to truncate. These tests pin
// the three behaviours that make the filter safe to run on every request:
// it excludes what genuinely cannot fit, it never excludes on absence of
// evidence, and it never turns "everything is too small" into "no route".

import { describe, expect, it } from 'vitest';
import { rankRouterCandidates, type AiRouterCandidate } from './ai-router-selection';

function candidate(
  model: string,
  contextWindowTokens: number | null | undefined,
  costPerMTok = 1,
): AiRouterCandidate {
  return {
    provider: 'testvendor',
    model,
    accessClass: 'metered',
    estimatedCostPerMTok: costPerMTok,
    contextWindowTokens,
  };
}

describe('filterByContextWindow', () => {
  it('drops a model whose window cannot hold the prompt', () => {
    const ranked = rankRouterCandidates(
      [candidate('small', 8_000), candidate('large', 200_000)],
      'budget',
      undefined,
      90_000,
    );
    expect(ranked.map((c) => c.model)).toEqual(['large']);
  });

  it('reserves headroom for the answer, so a model at exactly the limit loses', () => {
    // 100k prompt into a 100k window leaves nowhere to put a reply.
    const ranked = rankRouterCandidates(
      [candidate('exact', 100_000), candidate('roomy', 400_000)],
      'budget',
      undefined,
      100_000,
    );
    expect(ranked.map((c) => c.model)).toEqual(['roomy']);
  });

  it('keeps a cheaper small model when the prompt actually fits it', () => {
    // The filter must not become a general bias toward big models: at 4k the
    // small one is eligible and budget mode should still prefer it.
    const ranked = rankRouterCandidates(
      [candidate('small', 8_000, 1), candidate('large', 200_000, 50)],
      'budget',
      undefined,
      4_000,
    );
    expect(ranked[0]?.model).toBe('small');
  });

  it('filters nothing when the caller does not estimate a prompt size', () => {
    const ranked = rankRouterCandidates(
      [candidate('small', 8_000), candidate('large', 200_000)],
      'budget',
    );
    expect(ranked).toHaveLength(2);
  });

  it('never drops a candidate whose window is unknown', () => {
    // Unknown is not small. Excluding on absence would silently shrink the
    // pool for every provider that publishes no window.
    const ranked = rankRouterCandidates(
      [candidate('unknown', null), candidate('small', 8_000)],
      'budget',
      undefined,
      90_000,
    );
    expect(ranked.map((c) => c.model)).toEqual(['unknown']);
  });

  it('falls back to the roomiest model rather than returning no route', () => {
    // A prompt larger than everything available is a real situation. Failing
    // the request outright would be worse than the behaviour being fixed.
    const ranked = rankRouterCandidates(
      [candidate('tiny', 4_000), candidate('bigger', 32_000)],
      'budget',
      undefined,
      500_000,
    );
    expect(ranked[0]?.model).toBe('bigger');
    expect(ranked).toHaveLength(2);
  });

  it('does not reorder the caller’s array in place', () => {
    const input = [candidate('tiny', 4_000), candidate('bigger', 32_000)];
    const before = input.map((c) => c.model);
    rankRouterCandidates(input, 'budget', undefined, 500_000);
    expect(input.map((c) => c.model)).toEqual(before);
  });
});

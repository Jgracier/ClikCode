// ============================================
// RATE-LIMIT HEADROOM — the graded form of a question routing asked as yes/no
// ============================================
// The platform parsed vendor rate-limit headers on every dispatch and rendered
// them for admins, while routing consulted them only to ask "is this provider
// hard-stopped right now?". A provider at 3% headroom therefore ranked exactly
// like one at 95%, and bursts piled onto the top-scoring candidate until it
// tripped a limit that had been visible the whole time.
//
// These tests pin that the signal deprioritizes near exhaustion, stays silent
// everywhere else, and never becomes a ban.

import { describe, expect, it } from 'vitest';
import { rankRouterCandidates, type AiRouterCandidate } from './ai-router-selection';

function candidate(
  model: string,
  rateLimitHeadroom: number | null | undefined,
  arenaScore = 60,
): AiRouterCandidate {
  return {
    provider: model,
    model,
    accessClass: 'metered',
    estimatedCostPerMTok: 1,
    avgLatencyMs: 1000,
    arenaScore,
    rateLimitHeadroom,
  };
}

describe('rateLimitHeadroomFactor via frontier ranking', () => {
  it('prefers the provider with room when quality is otherwise equal', () => {
    const ranked = rankRouterCandidates(
      [candidate('nearly-exhausted', 0.02), candidate('plenty', 0.9)],
      'frontier',
    );
    expect(ranked[0]?.model).toBe('plenty');
  });

  it('ignores differences in the comfortable range', () => {
    // 60% vs 95% left says nothing about whether the next call succeeds.
    // If this became a signal it would add noise to every ranking, so the
    // higher-quality model must still win despite lower headroom.
    const ranked = rankRouterCandidates(
      [candidate('smarter-but-less-room', 0.6, 80), candidate('dimmer', 0.95, 70)],
      'frontier',
    );
    expect(ranked[0]?.model).toBe('smarter-but-less-room');
  });

  it('treats unknown headroom as no evidence of pressure', () => {
    const ranked = rankRouterCandidates(
      [candidate('unknown', null, 70), candidate('squeezed', 0.01, 70)],
      'frontier',
    );
    expect(ranked[0]?.model).toBe('unknown');
  });

  it('is a nudge, not a ban — a much better model still wins on empty', () => {
    // Floored at half, so a genuinely superior candidate under pressure is
    // still reachable rather than excluded outright.
    const ranked = rankRouterCandidates(
      [candidate('great-but-empty', 0, 100), candidate('poor-with-room', 1, 40)],
      'frontier',
    );
    expect(ranked[0]?.model).toBe('great-but-empty');
  });

  it('never promotes a candidate above one with full headroom and equal quality', () => {
    const ranked = rankRouterCandidates(
      [candidate('full', 1), candidate('half', 0.125)],
      'frontier',
    );
    expect(ranked[0]?.model).toBe('full');
  });
});

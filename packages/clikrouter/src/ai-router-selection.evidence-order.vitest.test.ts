import { describe, expect, it } from 'vitest';
import { rankRouterCandidatesWithScores, type AiRouterCandidate } from './ai-router-selection';

// ── THE TEST THE RANKER DID NOT HAVE ─────────────────────────────────────────
// Every existing selection test pins ONE factor in isolation (context-window,
// rate-limit-headroom, throughput-status). None asserted that two realistic
// candidates come out in a stated ORDER for a stated reason — so a 15% systematic
// bias across the composition of seven multipliers lived undetected until it was
// found by running the real ranker by hand.
//
// These candidates are identical in every declared field except the evidence, so
// any ordering difference is attributable to how evidence is combined and
// nothing else.
// ─────────────────────────────────────────────────────────────────────────────

const IDENTICAL = {
  accessClass: 'free-tier' as const,
  estimatedCostPerMTok: 1,
  inputCostPerMTok: 1,
  contextWindowTokens: 131_072,
  arenaScore: 75,
  avgLatencyMs: 400,
};

const candidate = (over: Partial<AiRouterCandidate>): AiRouterCandidate =>
  ({ provider: 'p', model: 'm', ...IDENTICAL, ...over }) as AiRouterCandidate;

const PROVEN = candidate({
  provider: 'a',
  model: 'proven',
  trackRecordSuccessRate: 0.95,
  sustainRate: 0.92,
  sustainSampleSize: 50,
  externalUptime: 97,
  rateLimitHeadroom: 0.55,
});

const UNKNOWN = candidate({ provider: 'b', model: 'never-tried' });

const order = (list: AiRouterCandidate[]): string[] =>
  rankRouterCandidatesWithScores(list, 'auto', undefined, undefined, {
    preferThroughput: true,
  }).map((scored) => scored.candidate.model);

describe('a proven model must not lose to one nobody has tried', () => {
  it('ranks demonstrated reliability above an identical unknown', () => {
    // MEASURED BEFORE THE FIX: proven=81.14, never-tried=92.95. Six of the seven
    // capability multipliers were penalty-only and skipped when data was absent,
    // so a 95% success rate was a 5% penalty and no record at all was free. The
    // platform explored on live traffic, learned a model was good, then demoted
    // it for having a record.
    expect(order([PROVEN, UNKNOWN])).toEqual(['proven', 'never-tried']);
  });

  it('still ranks a demonstrably BAD model below the unknown', () => {
    // The fix must not turn "we have evidence" into a blanket bonus — a model
    // measured at 40% success is genuinely worse than an untried one.
    const bad = candidate({
      provider: 'c',
      model: 'proven-bad',
      trackRecordSuccessRate: 0.4,
      sustainRate: 0.3,
      sustainSampleSize: 50,
      externalUptime: 60,
    });
    expect(order([bad, UNKNOWN])).toEqual(['never-tried', 'proven-bad']);
  });

  it('treats performing exactly as expected the same as having no record', () => {
    // The equivalence centeredFactor exists to restore: "we measured it and it is
    // normal" and "we have never measured it" are the same claim about ranking.
    const asExpected = candidate({
      provider: 'd',
      model: 'as-expected',
      trackRecordSuccessRate: 0.9,
      externalUptime: 97,
    });
    const [first, second] = rankRouterCandidatesWithScores(
      [asExpected, UNKNOWN],
      'auto',
      undefined,
      undefined,
      { preferThroughput: true },
    );
    expect(first.compositeScore).toBeCloseTo(second.compositeScore ?? 0, 6);
  });
});

describe('no single source is the only source', () => {
  it('lets an external uptime feed lower a model that also has first-party history', () => {
    // The uptime prior used to be gated on `trackRecordSuccessRate == null`, so a
    // pair with ANY first-party record discarded the feed entirely — a vendor
    // endpoint flapping at 44% could not lower a model whose handful of calls
    // happened to land.
    const flapping = candidate({
      provider: 'e',
      model: 'flapping',
      trackRecordSuccessRate: 0.95,
      externalUptime: 44,
    });
    const healthy = candidate({
      provider: 'f',
      model: 'healthy',
      trackRecordSuccessRate: 0.95,
      externalUptime: 99,
    });
    expect(order([flapping, healthy])).toEqual(['healthy', 'flapping']);
  });

  it('lets an external latency feed move a candidate that has its own EWMA', () => {
    // Our EWMA used to win outright the instant it had any samples, so a feed
    // built from thousands of observations was silenced by one first-party call.
    const withFeed = candidate({
      provider: 'g',
      model: 'slow-per-feed',
      avgLatencyMs: 400,
      externalLatencyMs: 8000,
    });
    const withoutFeed = candidate({ provider: 'h', model: 'no-feed', avgLatencyMs: 400 });
    expect(order([withFeed, withoutFeed])).toEqual(['no-feed', 'slow-per-feed']);
  });

  it('consults both benchmarks rather than letting the agentic index veto arena', () => {
    const bothAgree = candidate({ provider: 'i', model: 'both', agenticIndex: 80, arenaScore: 80 });
    const arenaLow = candidate({ provider: 'j', model: 'arena-low', agenticIndex: 80, arenaScore: 20 });
    expect(order([bothAgree, arenaLow])).toEqual(['both', 'arena-low']);
  });
});

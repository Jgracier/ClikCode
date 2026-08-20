// Two signals the router gained after the first audit, both about speed and
// availability rather than capability:
//
//   THROUGHPUT — wall-clock latency conflates "how long until done" with "how
//   fast does it produce", and conflates them in the direction that punishes
//   the better model. Only meaningful on generation-heavy work, so it is
//   opt-in per request rather than always-on.
//
//   VENDOR INCIDENT — the only LEADING availability signal here. Everything
//   else waits for our own traffic to fail first.
import { describe, expect, it } from 'vitest';
import { rankRouterCandidates, type AiRouterCandidate } from './ai-router-selection';

function candidate(over: Partial<AiRouterCandidate> = {}): AiRouterCandidate {
  return {
    provider: over.model ?? 'p',
    model: 'm',
    accessClass: 'metered',
    estimatedCostPerMTok: 1,
    avgLatencyMs: 1000,
    arenaScore: 60,
    ...over,
  } as AiRouterCandidate;
}

describe('throughput', () => {
  const fast = candidate({ model: 'fast', throughputTokensPerSecond: 120 });
  const slow = candidate({ model: 'slow', throughputTokensPerSecond: 12 });

  it('is ignored unless the request is generation-heavy', () => {
    // A planner step that emits forty tokens is not better served by a fast
    // generator, and letting throughput move that ranking would be noise.
    //
    // Asserted as an INVARIANT rather than a fixed order: swapping the two
    // candidates' rates must not change the ranking at all. Pinning a literal
    // order here would pass on the alphabetical tiebreak these two fall through
    // to, which proves nothing about whether throughput was consulted.
    const order = (a: number, b: number) =>
      rankRouterCandidates(
        [
          candidate({ model: 'alpha', throughputTokensPerSecond: a }),
          candidate({ model: 'beta', throughputTokensPerSecond: b }),
        ],
        'frontier',
      ).map((c) => c.model);
    expect(order(120, 12)).toEqual(order(12, 120));
  });

  it('prefers the faster generator once the caller asks for it', () => {
    const ranked = rankRouterCandidates([slow, fast], 'frontier', undefined, undefined, {
      preferThroughput: true,
    });
    expect(ranked[0]?.model).toBe('fast');
  });

  it('treats an unmeasured pair as neutral, never slow', () => {
    // "Never generated enough to measure" is not evidence of anything.
    const unknown = candidate({ model: 'unknown', throughputTokensPerSecond: null });
    const ranked = rankRouterCandidates([slow, unknown], 'frontier', undefined, undefined, {
      preferThroughput: true,
    });
    expect(ranked[0]?.model).toBe('unknown');
  });

  it('stays a secondary signal — a much better model still wins', () => {
    // Twice as fast is not twice as good a choice.
    const brilliantButSlow = candidate({
      model: 'brilliant',
      arenaScore: 95,
      throughputTokensPerSecond: 10,
    });
    const dimButFast = candidate({
      model: 'dim',
      arenaScore: 40,
      throughputTokensPerSecond: 200,
    });
    const ranked = rankRouterCandidates(
      [dimButFast, brilliantButSlow],
      'frontier',
      undefined,
      undefined,
      { preferThroughput: true },
    );
    expect(ranked[0]?.model).toBe('brilliant');
  });
});

describe('vendor incident', () => {
  it('deprioritizes a candidate whose vendor declares an outage', () => {
    const healthy = candidate({ model: 'healthy' });
    const broken = candidate({ model: 'broken', vendorIncident: true });
    const ranked = rankRouterCandidates([broken, healthy], 'frontier');
    expect(ranked[0]?.model).toBe('healthy');
  });

  it('is a nudge, not a ban — a far better model under incident still wins', () => {
    // The signal is the vendor's summary of its WHOLE platform, which can be
    // red for something that never touches the endpoint we are calling.
    const ranked = rankRouterCandidates(
      [
        candidate({ model: 'great', arenaScore: 100, vendorIncident: true }),
        candidate({ model: 'poor', arenaScore: 20 }),
      ],
      'frontier',
    );
    expect(ranked[0]?.model).toBe('great');
  });

  it('treats absent/false as no evidence of a problem', () => {
    // No declared incident and no known status page are the same thing here,
    // and neither is a claim of health.
    const noPage = candidate({ model: 'no-page' });
    const declaredFine = candidate({ model: 'fine', vendorIncident: false });
    const ranked = rankRouterCandidates([noPage, declaredFine], 'frontier');
    expect(ranked).toHaveLength(2);
    // Neither is discounted, so the tie breaks on model name alone.
    expect(ranked.map((c) => c.model).sort()).toEqual(['fine', 'no-page']);
  });
});

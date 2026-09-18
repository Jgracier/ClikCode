// ============================================
// AI ROUTER SELECTION — the ranking logic behind every "auto/budget/frontier/explicit" choice.
// ============================================
// ONE ranking algorithm, used both by the persisted per-agent routing strategy
// (AiRoutingStrategy in ai-routing.ts — what automatic production routing actually does) and by
// the admin test-chat picker (previously a second, disconnected implementation that only lived in
// apps/web and used a cruder cost-only ranking for automatic modes) — so testing an agent's
// "Auto" mode and that agent's real automatic routing are provably the same computation, not two
// systems that happened to agree by coincidence.
//
// Pure and dependency-free on purpose: no db/redis/env access, so it is safe for both the server
// (ai-default-llm.ts) and — if a client ever needs it — a browser bundle.
//
// The one import below is a sibling PURE module (ai-evidence.ts) — how several
// sources of one measurement are combined, and how a measurement becomes a score
// multiplier. It carries no I/O either, so the property above is intact.

import {
  centeredFactor,
  constraintFactor,
  fuseEvidence,
  sampleWeight,
} from './ai-evidence';

/**
 * 'auto' / 'auto-budget' / 'auto-frontier' are the "auto family" — all three
 * blend intelligence, access tier, cost, and latency into ONE composite score
 * via `autoComposite` (see AUTO_COMPOSITE_WEIGHTS below for how the three
 * differ), and all three explore under-sampled candidates via
 * `applyExploration`. 'auto' is the balanced point among them and keeps its
 * EXACT pre-existing meaning/weights — nothing about its behavior changed
 * when the other two were added, so anything that already persisted the
 * literal string 'auto' keeps working unchanged.
 *
 * 'budget' / 'frontier' are a DELIBERATELY DIFFERENT, blunter pair: a rigid
 * lexicographic sort (cost-then-tiebreak, or intelligence-then-tiebreak — see
 * `compareScored`) with zero exploration, for a caller that wants an exact,
 * repeatable answer ("cheapest, period" / "strongest, period") rather than a
 * judgment call. They are not a lesser version of auto-budget/auto-frontier;
 * they answer a different question on purpose and are left untouched by the
 * auto-family additions.
 */
export type AiRoutingStrategy = 'auto' | 'auto-budget' | 'auto-frontier' | 'budget' | 'frontier' | 'explicit';

/** True for any of the three composite-blending, exploring modes — the
 *  grouping `compareScored`, `rankRouterCandidatesWithScores`, and
 *  `applyExploration` all key off of to decide "does this mode use the
 *  blended composite / explore" as opposed to a rigid lexicographic sort. */
function isAutoFamily(mode: AiRoutingStrategy): mode is 'auto' | 'auto-budget' | 'auto-frontier' {
  return mode === 'auto' || mode === 'auto-budget' || mode === 'auto-frontier';
}

export interface AiRouterCandidate {
  provider: string;
  model: string;
  /**
   * 'subscription' — an OAuth credential dispatched DIRECTLY over HTTP
   * (subscriptionTransport: 'direct' — Codex, Code Assist). 'subscription-
   * harness' — an OAuth credential spent through the vendor's own CLI
   * (subscriptionTransport: 'harness' — Anthropic → Claude Code). Both are
   * "you already have access, this is not metered spend" for ranking/cost
   * purposes (see ACCESS_RANK below), but kept as distinct literals so a
   * consumer can tell "plain HTTP call" apart from "runs a real subprocess"
   * by accessClass alone — the harness tier carries a materially bigger
   * trust surface that a user-facing dispatch mode must be able to exclude
   * without also excluding the direct one.
   */
  accessClass: 'subscription' | 'subscription-harness' | 'free-tier' | 'metered' | 'unknown';
  estimatedCostPerMTok: number | null;
  /**
   * The INPUT half of `estimatedCostPerMTok`, kept separately because caching
   * only ever discounts input. Absent when no price is on file.
   */
  inputCostPerMTok?: number | null;
  /**
   * What a CACHE-READ input token costs on this model, per MTok. Absent means
   * the vendor publishes no cached rate — which is not the same as caching
   * being free, so an absent value disables the discount below rather than
   * being read as zero.
   */
  cachedInputCostPerMTok?: number | null;
  /**
   * Minimum prompt-prefix tokens before this model's cache applies at all.
   *
   * KNOWING A MODEL CAN CACHE SAYS NOTHING ABOUT WHETHER THIS PROMPT WILL.
   * MEASURED 2026-09-10 from LiteLLM's published table: 226 models state a
   * minimum and 80 of them sit ABOVE the 1,500-token prefix the ClikNet
   * remediation agent declares — Claude Opus 4.6/4.7 and Haiku 4.5 at 2048 and
   * 4096. For those, the caller's prefix would never be cached and the discount
   * below was pure invention.
   *
   * Absent means no known minimum, and must keep meaning that: withdrawing a
   * real discount because a feed is silent would be the same error in the other
   * direction.
   */
  promptCacheMinTokens?: number | null;
  /**
   * OBSERVED share of eligible input tokens this pair actually served from
   * cache, 0-1, with the prompt tokens it was measured over.
   *
   * Takes precedence over the caller's declared prefix size in the cost term
   * below, because the declared figure is a property of the PROMPT and this is
   * a property of the PAIR — and the two disagree wildly in practice. Measured
   * on production 2026-08-20: byte-identical ClikNet prompts hit 55.6% on
   * Mistral and 5.1% on SambaNova. Pricing both off the same declared prefix
   * flatters one of them by an order of magnitude.
   */
  observedCacheHitRate?: number;
  observedCacheEligibleTokens?: number;
  /**
   * Live exponential-moving-average response latency in ms (ai-model-latency.ts),
   * or null/absent when never observed. This file stays pure/dependency-free
   * (see the module comment), so it never reads Redis itself — the caller
   * (ai-router-candidates.ts) fetches it and attaches it here, the same way it
   * already does for accessClass/estimatedCostPerMTok.
   */
  avgLatencyMs?: number | null;
  /**
   * Real third-party agentic-capability score, 0-100 (ai-openrouter-
   * benchmarks.ts's `agentic_index`), when this exact (provider, model) pair
   * matched OpenRouter's public catalog — absent for the majority of pairs
   * (measured live: only ~10 of 43 providers even share a namespace with
   * OpenRouter, so most candidates never get this). Same caller-attaches
   * posture as avgLatencyMs; this file never fetches it itself.
   */
  agenticIndex?: number | null;
  /**
   * Artificial Analysis' general-capability index, from the SAME object
   * `agenticIndex` comes from and published through the vendor's own catalog.
   *
   * Declared in the benchmark module's response type and extracted by nothing
   * until now. Fused as corroborating evidence rather than given precedence:
   * the agentic index measures tool-driven task completion, which is what this
   * router dispatches, so it stays dominant. This gives the term a
   * VENDOR-PUBLISHED second opinion before it falls back to a community feed.
   */
  intelligenceIndex?: number | null;
  /**
   * LMArena text-arena human-preference rating, percentile-scaled to 0-100
   * across the current leaderboard snapshot (platform-domains'
   * ai-quality-feed.ts) — a SECOND real intelligence source with much wider
   * coverage than agenticIndex, matched onto our model ids by conservative
   * name normalization (unambiguous matches only, never a guess). A
   * DIFFERENT measurement than agenticIndex (crowd preference on chat
   * answers vs. a measured agentic benchmark), so it is its own field:
   * `baseCapabilityScore` prefers agenticIndex where present and only fills
   * with this where agenticIndex is absent. Same caller-attaches posture as
   * avgLatencyMs; this file never fetches it itself.
   */
  arenaScore?: number | null;
  /**
   * Real observed success rate in [0, 1] from THIS platform's own routing
   * history (ai-model-track-record.ts), only present once there is enough of
   * it to trust (see that module's MIN_TRACK_RECORD_SAMPLES) — absent means
   * "no track record yet", never "confirmed unreliable". Same caller-attaches
   * posture as avgLatencyMs.
   */
  trackRecordSuccessRate?: number | null;
  /**
   * Trailing-14-day count of real observed "I don't have that capability"
   * hallucinations FROM THIS EXACT MODEL, despite a real tool being attached
   * to the call (ai-model-capability.ts's recordObservedCapabilityRefusal /
   * readCapabilityRefusalCounts — cross-provider, keyed by
   * normalizeModelKey). Absent or 0 means no observed refusals, never
   * "confirmed reliable". Same caller-attaches posture as avgLatencyMs.
   */
  capabilityRefusalCount?: number | null;
  /**
   * Real observed rate in [0, 1] of this (provider, model) pair FINISHING an
   * agent-loop turn with a real answer, vs. giving up mid-task
   * (ai-model-task-completion.ts's getModelSustainRates — see MIN_SUSTAIN_SAMPLES
   * for the trust floor). A DIFFERENT question than trackRecordSuccessRate:
   * that answers "did the dispatch call error", this answers "did the model
   * actually complete the multi-step task it was given" — the two are
   * independent (MEASURED: a model can dispatch cleanly on every individual
   * tool call and still never produce a final answer). Absent means "not
   * enough agent-loop samples yet", never "confirmed can't finish long
   * tasks" — same caller-attaches posture as avgLatencyMs.
   */
  sustainRate?: number | null;
  /** Sample size backing sustainRate, for callers that want their own trust
   *  threshold instead of relying on the read layer's MIN_SUSTAIN_SAMPLES gate. */
  sustainSampleSize?: number | null;
  /**
   * MEASURED third-party endpoint latency for this exact (provider, model)
   * pair, in ms (TTFT-shaped — Vercel AI Gateway's latency_last_1h p50 via
   * platform-domains' ai-endpoint-health-feed.ts). A PRIOR, never an
   * override: `latencyScore` consults it ONLY when avgLatencyMs is absent —
   * i.e. exactly where the neutral 3s constant would otherwise stand in.
   * Our own EWMA, once it has even one sample, is never displaced by this.
   * Same caller-attaches posture as avgLatencyMs.
   */
  externalLatencyMs?: number | null;
  /**
   * MEASURED third-party uptime_last_1d for this exact pair, percent 0-100
   * (pessimistic minimum across the feed's sources — same module). Only ever
   * used to DEPRIORITIZE: `intelligenceWithReliability` applies a penalty
   * when this is below LOW_EXTERNAL_UPTIME_THRESHOLD AND this platform has
   * NO track record of its own for the pair — real first-party evidence
   * (trackRecordSuccessRate present) always supersedes the external prior
   * entirely. Same caller-attaches posture as avgLatencyMs.
   */
  externalUptime?: number | null;
  /**
   * The model's REAL total context window in tokens, when it is known — the
   * vendor's own per-model catalog figure (AiProviderModel.contextWindowTokens)
   * where discovery captured one, otherwise the provider's registry floor.
   *
   * A SELECTION signal, not a scoring one. Every other field here answers "how
   * good is this candidate"; this answers the prior question "can it hold the
   * request at all", and the two must not be blended — a model that cannot fit
   * the prompt is not a slightly worse choice, it is the wrong one. So it is
   * consumed by an eligibility filter (see `filterByContextWindow`) rather than
   * by `autoComposite`.
   *
   * This gap was real and silent: the platform has learned per-model windows
   * from vendor catalogs for a while and used them only DOWNSTREAM, when
   * shaping the prompt. Selection ran first and could not see them, so an
   * oversized job could rank a small model first on cost and latency and then
   * arrive at a prompt shaper whose only remaining option was to cut the
   * context down to fit — quietly degrading the answer instead of routing to a
   * model that fits. Absent means "not known", never "too small".
   */
  contextWindowTokens?: number | null;
  /**
   * Fraction of this PROVIDER's tightest published rate-limit window still
   * available, 0-1, from the vendor's own response headers on the last real
   * call (ai-rate-limit-telemetry.ts). Null/absent when the provider publishes
   * no usable limit headers, or none have been seen yet.
   *
   * Only ever used to DEPRIORITIZE, and only near the bottom of the range —
   * see `constraintFactor` (ai-evidence.ts). The platform already parsed these headers on
   * every dispatch and rendered them in the admin panel, but routing asked them
   * exactly one binary question ("is this provider hard-stopped right now?"), so
   * a provider at 3% headroom ranked identically to one at 95% and bursts piled
   * onto whichever scored highest until it tripped a limit that was visible all
   * along. Absent means "no evidence of pressure", never "under pressure".
   */
  rateLimitHeadroom?: number | null;
  /**
   * How much room this candidate's PROVIDER has left — money, subscription
   * window, or rate-limit bucket — normalized to one factor by
   * ai-provider-capacity.ts. 1 means no adjustment (plenty, or nothing
   * published); below 1 discounts a provider close to refusing.
   *
   * A CONSTRAINT, never a quality: a provider with more credit is not a better
   * model, only less likely to 402 mid-turn, so this can never exceed 1. It is
   * separate from `rateLimitHeadroom` because that reads one window from the
   * last response's headers, while this folds in the vendor's own balance
   * endpoint — the number that told us openrouter, moonshot and hyperbolic were
   * at $0.00 while the router treated them as ordinary candidates.
   */
  capacityFactor?: number | null;
  /**
   * Observed generation rate in output tokens per second
   * (ai-model-throughput.ts), or null/absent when this pair has never produced
   * a long enough turn to measure.
   *
   * A SECOND speed signal, and deliberately not folded into `avgLatencyMs`.
   * Wall clock answers "how long until this turn is done", which is what a
   * short planner step is judged on; this answers "how fast does it produce",
   * which is what decides the wait on a long generation. Conflating them
   * punishes the better model — a turn that took 8s to write 4,000 tokens
   * looks slower than one that took 3s to write 200.
   *
   * Consumed ONLY when the caller says the request is generation-heavy (see
   * `preferThroughput`), because for everything else the existing latency
   * signal is the right one and adding this would be noise.
   */
  throughputTokensPerSecond?: number | null;
  /**
   * MEASURED third-party generation rate for this exact pair, tokens/second
   * (the public gateway feed's throughput p50).
   *
   * A PRIOR, never an override — the same precedence `externalLatencyMs` has
   * against our own latency EWMA: consulted ONLY where we have no measurement
   * of our own, and instantly superseded once we do. It exists because
   * first-party throughput can only be learned by routing to a pair, so
   * without a prior a never-tried model stays unmeasured indefinitely and the
   * signal can never help pick it.
   */
  externalThroughputTps?: number | null;
  /**
   * This candidate's VENDOR is currently declaring a major or critical
   * incident on its own public status page (vendor-status-feed.ts).
   *
   * The only LEADING availability signal here — every other one waits for our
   * own traffic to fail first. It exists to avoid the first burned attempt of
   * an outage, not to override what our traffic has since proven, so it is a
   * discount rather than an exclusion: a status page can be scoped to a
   * console outage that never touches inference, and vendors are often slower
   * to close an incident than to open one.
   *
   * Absent/false means no declared incident OR no known status page — both
   * genuinely "no evidence of a problem", never a claim of health.
   */
  vendorIncident?: boolean | null;
}

export interface AiRouterSelection {
  provider: string;
  model: string;
  reason: string;
}

/**
 * The scored breakdown behind ONE candidate's position in the ranking —
 * the terms `rankRouterCandidates`'s comparator uses, made visible instead of
 * being computed and discarded inside a sort callback. `compositeScore` is
 * only meaningful for auto-family modes ('auto' / 'auto-budget' /
 * 'auto-frontier' — the only modes that blend terms into one number); the
 * other modes rank lexicographically over these same terms in a fixed
 * priority order (see `compareScored`'s per-mode branches).
 */
export interface AiRouterCandidateScore {
  candidate: AiRouterCandidate;
  accessRank: number;
  cost: number;
  intelligence: number;
  latencyMs: number;
  compositeScore: number | null;
}

/**
 * The access-tier order every mode ranks by, best first:
 *
 *   subscription → free-tier → metered → unknown
 *
 * SUBSCRIPTION AHEAD OF FREE, and the reason is measured rather than tasteful.
 * Included capacity is already paid for and is where the operator's strongest
 * models live; a vendor free tier is rate-limited (20 requests/day at one
 * vendor), often account-dependent, and is the tier a vendor moves to billing
 * from. With free-tier ranked FIRST (as this table had it), a connected
 * Anthropic subscription with 62% of its window unused was never chosen once
 * in 30 days while a "free" 3B model took 3,903 calls — the router preferred
 * the cheapest-looking tier over the one it had actually been given.
 *
 * 'subscription' and 'subscription-harness' share a rank on purpose: both are
 * non-metered included capacity. The transport distinction matters for
 * ELIGIBILITY (ai-router-candidates.ts), never for how an eligible candidate
 * ranks.
 */
const ACCESS_RANK: Record<AiRouterCandidate['accessClass'], number> = {
  subscription: 0,
  'subscription-harness': 0,
  'free-tier': 1,
  metered: 2,
  unknown: 3,
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 50: the flat score for a candidate with NO real capability evidence at
 * all — no OpenRouter agentic_index match (ai-openrouter-benchmarks.ts) and
 * no track record yet (ai-model-track-record.ts). This file used to guess a
 * tier from the model's NAME via a regex (gpt-5/claude-opus/… → 110, "flash"/
 * "mini" → 60, anything else → 75) — a genuine guess dressed up as a score,
 * and it was actively winning against REAL data: an unbenchmarked model
 * defaulted to 110 while a real, measured flagship could score lower (Claude
 * Opus 5's actual agentic_index is 59.2), so the fabricated number was
 * outranking the true one. Removed entirely rather than kept as a fallback —
 * "never use unverified data for model intelligence" means exactly that, not
 * "prefer verified data when convenient".
 *
 * 50 sits in the middle of the plausible 0-100 agentic_index range on
 * purpose, not derived from a live-data snapshot (a hardcoded median would
 * just be a slower-moving version of the same guessing problem). It is
 * ABOVE real low scores this platform has actually observed (nvidia's
 * Nemotron-3-Nano measured 2, several others sit in the 20s-30s) and BELOW
 * real high scores (Claude Opus 5 at 59.2, Claude Fable 5 at 56.6) — a
 * measured LOW score is real negative evidence and must still rank below an
 * unknown-quality model, same as a measured HIGH score must still rank
 * above one. "Unknown" is genuinely neutral, never a synonym for "assume the
 * best" or "assume the worst".
 *
 * Coverage is currently thin — measured live 2026-08-09: only 17 of 629 real
 * routable (provider, model) pairs had a benchmark match at all. Most
 * candidates get this neutral default today, which means "frontier" mode
 * mostly stops differentiating on capability until real evidence (benchmark
 * coverage growing, or this platform's own track record accumulating
 * enough samples) exists to differentiate with — that is the honest state
 * of what is actually known, not a regression to fix by guessing again.
 */
/**
 * How much a first-party measurement may outweigh a third-party feed once it is
 * fully sampled. 2:1 — ours counts double, and NEVER silences theirs. See
 * ai-evidence.ts's header for why outright precedence was the wrong reading of
 * "our measurement is better evidence".
 */
const FIRST_PARTY_FULL_WEIGHT = 2;
const EXTERNAL_FEED_WEIGHT = 1;

/** Samples at which a first-party reading carries its full weight. */
const LATENCY_TRUSTED_SAMPLES = 20;

const NEUTRAL_CAPABILITY_SCORE = 50;

/**
 * Real third-party capability data, in strict precedence order — never a
 * name-based guess:
 *   1. `agenticIndex` (ai-openrouter-benchmarks.ts's `agentic_index`) — a
 *      MEASURED agentic benchmark, the closest thing to what this router
 *      actually dispatches (tool-calling agent loops), used directly, not
 *      remapped through an invented conversion formula.
 *   2. `arenaScore` (platform-domains' ai-quality-feed.ts) — LMArena
 *      human-preference Elo, percentile-scaled to the same 0-100 range so
 *      the snapshot's median model lands at exactly NEUTRAL_CAPABILITY_SCORE
 *      (see that module's SCALING CHOICE header). Wider coverage, weaker
 *      task-fit (crowd chat preference ≠ agentic ability), so it only FILLS
 *      where the measured agentic number is absent — it never overrides it.
 *   3. NEUTRAL_CAPABILITY_SCORE when neither exists.
 */
function baseCapabilityScore(candidate: AiRouterCandidate): number {
  // BOTH benchmarks, weighted — not "agentic wins, arena ignored". They measure
  // genuinely different things (task-fit vs breadth of human preference) and are
  // both real measurements of the same underlying question. The agentic index is
  // the better-fitting one, so it counts double; the arena score still moves the
  // result rather than being discarded the moment the other exists.
  return (
    fuseEvidence([
      { value: candidate.agenticIndex, weight: FIRST_PARTY_FULL_WEIGHT },
      // Same publisher as the agentic index and reached through the vendor's
      // own catalog, so it is better provenance than the community arena — but
      // it measures general capability rather than the agent loops this router
      // actually runs, so it corroborates at the arena's weight rather than
      // competing with the agentic number.
      { value: candidate.intelligenceIndex, weight: EXTERNAL_FEED_WEIGHT },
      { value: candidate.arenaScore, weight: EXTERNAL_FEED_WEIGHT },
    ]) ?? NEUTRAL_CAPABILITY_SCORE
  );
}

/**
 * Capability (above), discounted by real observed reliability on THIS
 * platform when there is enough of it to trust — a MULTIPLIER, not a
 * replacement: capability answers "how smart is this model" (a real
 * benchmark, or neutral when unknown), reliability answers "does it
 * actually deliver that for us" (from our own routing history), and those
 * are genuinely different questions. A model this platform has actually
 * seen succeed only 40% of the time is not delivering its benchmark
 * intelligence to real users regardless of how it scored on someone else's
 * eval, so its effective score here is crushed accordingly. Absent track
 * record (never routed to here yet, or too few recent samples — see
 * ai-model-track-record.ts) leaves capability unadjusted: "no track record
 * yet" must never be penalized the way "confirmed unreliable" is.
 */
function intelligenceWithReliability(
  candidate: AiRouterCandidate,
  preferThroughput = false,
  referenceThroughput: number | null = null,
): number {
  let capability = baseCapabilityScore(candidate);

  // ── QUALITY SIGNALS: symmetric, centred on what is expected ───────────────
  // Each of these used to be `capability *= rate` — penalty-only, skipped when
  // absent. A 98%-reliable model was multiplied by 0.98 while a model nobody had
  // ever called was multiplied by nothing, so knowing a model was GOOD ranked it
  // below knowing nothing at all. See ai-evidence.ts for the measured case.
  //
  // Centred instead: at the expected rate the factor is exactly 1 — identical to
  // having no data, which is the correct equivalence ("assumed to perform as
  // expected"). Above it earns a bounded bonus; below it takes the same discount
  // it always did.
  capability *= centeredFactor(candidate.trackRecordSuccessRate, {
    expected: EXPECTED_SUCCESS_RATE,
    min: 0.2,
    max: 1.15,
  });

  // Tool-call refusals stay penalty-only and are NOT centred: zero refusals is
  // the norm, not an achievement, so there is no "better than expected" side to
  // reward. Same 15%-per-refusal nudge, floored, as before.
  if (
    typeof candidate.capabilityRefusalCount === 'number' &&
    Number.isFinite(candidate.capabilityRefusalCount) &&
    candidate.capabilityRefusalCount > 0
  ) {
    capability *= Math.max(0.4, 1 - candidate.capabilityRefusalCount * 0.15);
  }

  // EXTERNAL UPTIME — now ALWAYS consulted, not only when first-party history is
  // absent. It used to be gated on `trackRecordSuccessRate == null`, which is the
  // same one-source-wins mistake as latency and throughput: a pair with a track
  // record had its uptime feed discarded entirely, so a vendor endpoint flapping
  // at 44% could not lower a model whose few first-party calls happened to land.
  // Both are real measurements of reliability, so both count — the first-party
  // rate leads by weight (above), and this contributes a smaller, bounded
  // adjustment of its own rather than an all-or-nothing veto.
  capability *= centeredFactor(candidate.externalUptime, {
    expected: EXPECTED_EXTERNAL_UPTIME,
    min: 0.5,
    max: 1.05,
  });

  // Long-horizon completion, once there are enough samples to mean anything.
  if (
    typeof candidate.sustainSampleSize === 'number' &&
    candidate.sustainSampleSize >= MIN_SUSTAIN_SAMPLES_TRUSTED
  ) {
    capability *= centeredFactor(candidate.sustainRate, {
      expected: EXPECTED_SUSTAIN_RATE,
      min: 0.3,
      max: 1.1,
    });
  }

  // ── CONSTRAINT SIGNALS: penalty-only, deliberately asymmetric ─────────────
  // A provider sitting at 95% free quota is not BETTER than one at 60% free — it
  // is merely unconstrained, and paying a bonus for idleness would rank an unused
  // provider above a proven busy one. Same for a declared incident: there is no
  // "extra healthy". These stay one-directional on purpose; see ai-evidence.ts.
  capability *= constraintFactor(candidate.rateLimitHeadroom, {
    comfortable: RATE_LIMIT_PRESSURE_THRESHOLD,
    floor: MIN_RATE_LIMIT_FACTOR,
  });

  // Account-level room to serve: credit balance and subscription windows, which
  // the per-response rate-limit headers above cannot see. Already computed as a
  // penalty-only factor by ai-provider-capacity.ts.
  if (
    typeof candidate.capacityFactor === 'number' &&
    Number.isFinite(candidate.capacityFactor) &&
    candidate.capacityFactor > 0
  ) {
    capability *= Math.min(1, candidate.capacityFactor);
  }

  if (preferThroughput) {
    capability *= throughputFactor(candidate, referenceThroughput);
  }

  if (candidate.vendorIncident === true) {
    capability *= VENDOR_INCIDENT_FACTOR;
  }
  return capability;
}

/** Mirrors ai-model-task-completion.ts's own MIN_SUSTAIN_SAMPLES — duplicated
 *  here (this file is deliberately dependency-free, see the module header)
 *  rather than imported, so a caller that fetched with a looser threshold
 *  can never leak an under-trusted rate into scoring. */
/**
 * What a competent model is EXPECTED to achieve — the centre each quality factor
 * scales around (ai-evidence.ts's centeredFactor).
 *
 * Real domain numbers, deliberately NOT a median of whatever is in the pool
 * today: a pool median drifts with the pool, so a fleet-wide degradation would
 * quietly redefine "expected" downward and nothing would score badly again.
 */
const EXPECTED_SUCCESS_RATE = 0.9;
const EXPECTED_SUSTAIN_RATE = 0.8;
const EXPECTED_EXTERNAL_UPTIME = 97;

const MIN_SUSTAIN_SAMPLES_TRUSTED = 5;

/**
 * 90%: below this, an externally MEASURED uptime_last_1d marks an endpoint as
 * genuinely degraded rather than normally variable. Deliberately
 * conservative: healthy endpoints observed live on the feed sit at 96-100%
 * even during routine operation (transient sub-100 readings are normal), and
 * a prior must only ever move a ranking on a clear signal — 90% for a full
 * day means roughly 2.4 cumulative hours of failures, which no healthy
 * endpoint shows. Used ONLY when this platform has no track record of its
 * own for the pair — see AiRouterCandidate['externalUptime'].
 */
export const LOW_EXTERNAL_UPTIME_THRESHOLD = 90;

/**
 * Catches a model that is almost certainly NOT chat-capable, from its id
 * alone — the router has nothing else to go on. `isTextRoutable`
 * (ai-provider-registry's lookups.ts) already excludes whole PROVIDERS whose
 * only modality is non-text (voyage, elevenlabs, fal, …), which is real data,
 * not a guess. This exists for the gap that leaves open: a provider that DOES
 * serve chat (Cloudflare, Groq, HuggingFace, Mistral, …) but ALSO lists
 * TTS/embedding/image/ASR/moderation models in the SAME catalog, with no
 * per-model modality field anywhere in the schema to check instead (verified:
 * AiDiscoveredModel carries only id/pricing/enabled). Observed live via
 * `clikdeploy admin ai chat --explain`: cloudflare/@cf/baai/bge-base-en-v1.5
 * (an embedding model) and groq/whisper-large-v3-turbo (speech-to-text) both
 * ranked as router candidates for a plain text chat request.
 *
 * Deliberately a DENYLIST, not an allowlist: an allowlist of "known chat
 * model name shapes" would silently exclude every future chat model whose
 * name doesn't match a pattern written today. A denylist only ever excludes
 * what it explicitly recognizes as non-chat, so an unrecognized new model
 * defaults to ELIGIBLE — the same "unknown is not confirmed bad" principle
 * `NEUTRAL_CAPABILITY_SCORE` above already applies to capability tier.
 *
 * False negatives (a genuine chat model this misses and wrongly excludes)
 * are the failure mode to watch for — a name containing "vision" or
 * "instruct" must never trip these patterns just because it also contains a
 * substring like "tts" or "embed" as part of an unrelated word.
 */
export function isLikelyChatModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  const patterns: RegExp[] = [
    // Text-to-speech / audio generation.
    /\btts\b|-tts-|-tts$|text-to-speech|\bspeech-\d|melotts|\baura(-\d)?\b|\bsonic\b/,
    // Speech-to-text / transcription / audio-in chat.
    //
    // `voxtral` is Mistral's AUDIO family and is the reason this line was widened.
    // MEASURED 2026-08-10: with cliknet enabled, EVERY remediation run for the whole
    // 20-app fleet routed to mistral/voxtral-small-latest and voxtral-small-2507 —
    // an audio model handed tool definitions to propose code fixes. Mistral's catalog
    // publishes no per-model modality field, so `chatCapable` was undefined and this
    // heuristic was the only thing standing between an audio model and the agent lane;
    // it recognized no `voxtral` shape, so the model was treated as chat-eligible.
    // Confirmed against the live router state: no `ai:model-chat-capable:voxtral-*`
    // key exists, i.e. no vendor ever published a verdict for it.
    /whisper|paraformer|transcribe|nova-\d.*transcri|\basr\b|voxtral|\bqwen\d*-audio\b|-audio$|-audio-|audio-preview|\bseamless(m4t)?\b|\bwav2vec\b|\bmms-\d/,
    // Embeddings / reranking.
    /\bembed(ding)?s?\b|-embed-|bge-|gte-|(^|-)e5-|nomic-embed|embeddinggemma|\brerank(er)?\b/,
    // Image / video generation.
    /flux|stable-diffusion|\bsdxl\b|dall-e|gpt-image|\bimagen\b|dreamshaper|-image$|-image-|image-lightning|inpainting|img2img|\bveo\b|\bsora\b|^ray-|-video$|-video-|video-01|minimax-video|speech-02/,
    // Moderation / safety / guard classifiers — real models, never a chat
    // answer's source.
    /omni-moderation|llama-guard|nemoguard|-guard-|safeguard|content-safety|topic-control/,
    // Misc non-chat utility models observed in mixed catalogs.
    /\bocr\b|resnet|\bdetr\b|m2m100|\bnllb\b|indictrans/,
  ];
  return !patterns.some((re) => re.test(id));
}

/**
 * An ABSOLUTE veto, checked BEFORE any vendor `chatCapable` field — unlike
 * every other exclusion in this file, a real modality fact from the vendor
 * is deliberately NOT allowed to override this one.
 *
 * Fill-In-the-Middle (code-completion: prompt+suffix, not chat turns) is a
 * REQUEST-SHAPE incompatibility, not a modality question `chatCapable` was
 * designed to answer. MEASURED LIVE 2026-08-10: Mistral's catalog publishes
 * `capabilities.completion_chat: true` for mistral-code-fim-latest — almost
 * certainly meaning "reachable via our /v1/chat/completions endpoint" (true
 * for nearly every model Mistral hosts, FIM included), not "accepts
 * open-ended conversation". Routed to for a real user's AI_ASSISTANT_CHAT
 * turn, it produced exactly the unusable non-answer ("I don't have that
 * capability") a model built for prompt/suffix completion would, since this
 * platform only ever sends normal chat-turn requests, never FIM-shaped
 * (prompt/suffix) ones. A vendor field answering a different question than
 * the one being asked is not real evidence for THIS question, so it does
 * not get the usual "vendor beats heuristic" precedence here.
 */
export function isFillInMiddleModel(modelId: string): boolean {
  return /\bfim\b|-fim-|-fim$/i.test(modelId);
}

/**
 * A SECOND absolute veto, same precedence and same reasoning shape as
 * isFillInMiddleModel above — checked BEFORE any vendor `chatCapable` field,
 * never overridden by one.
 *
 * MEASURED LIVE 2026-08-11, cross-referenced against the full production
 * catalog: safety/moderation classifiers — Llama Guard (meta/llama-guard-*,
 * meta-llama/Llama-Guard-*), Llama Prompt Guard, NVIDIA's Nemoguard/
 * content-safety family, openai/gpt-oss-safeguard-20b — carry `chatCapable:
 * true` from SOME catalogs (HuggingFace and OpenRouter both publish
 * `architecture.output_modalities: ["text"]` for these, because the model
 * genuinely does emit text: a classification verdict, not a conversational
 * reply) while OTHER catalogs for the identical id publish no chatCapable
 * field at all. Either way the vendor field is answering "does this model
 * produce text output", not "does it hold a conversation" — the exact same
 * category error isFillInMiddleModel's own doc comment describes for
 * mistral-code-fim-latest. Routing a real chat turn to a safety classifier
 * would return a moderation verdict ("safe"/"unsafe" or similar), not an
 * answer to the user's question — a materially worse failure than the
 * FIM case, since nothing about the response would look like an error to
 * the caller.
 *
 * Deliberately name/id-pattern-based rather than trying to read a
 * capabilities.moderation-style field: no catalog in this platform's probe
 * coverage publishes one, so a name veto is the only real signal available,
 * same justification NEUTRAL_CAPABILITY_SCORE gives for why a heuristic is
 * sometimes the honest fallback rather than a fabricated field read.
 */
export function isSafetyClassifierModel(modelId: string): boolean {
  return /guard|nemoguard|safeguard|content-safety|topic-control|moderation/i.test(modelId);
}

/**
 * Whether a model is eligible for text chat routing.
 *
 * ── THE PRECEDENCE, AND WHY IT CHANGED ─────────────────────────────────────
 *
 * A vendor's `chatCapable` used to override the name denylist, on the ordinary
 * and usually-correct principle that a published fact beats a guess. Two
 * exceptions were carved out by hand after two production incidents
 * (isFillInMiddleModel, isSafetyClassifierModel), each with the same
 * explanation: `architecture.output_modalities` answers "does this model emit
 * text", which is NOT the question being asked. A FIM completer emits text. A
 * moderation classifier emits text. Neither holds a conversation.
 *
 * MEASURED against all 430 models of OpenRouter's live public catalog on
 * 2026-09-09, every one of which publishes output_modalities, so this is the
 * whole population and not a sample. The denylist and the vendor field
 * disagree on 16 models, always in the same direction (vendor says chat, name
 * says not — the reverse never occurs once). All 16 are genuinely not chat
 * models: eight image generators (google/gemini-3-pro-image,
 * openai/gpt-5-image, …), two audio models (openai/gpt-audio,
 * gpt-audio-mini), the three safety classifiers and one FIM-adjacent entry the
 * hand-carved vetoes already caught, and mistralai/voxtral-small-24b-2507.
 *
 * The denylist was right 16 times out of 16. The vendor field, read as
 * `includes("text")`, was wrong 16 times out of 16 on exactly the cases where
 * the two disagree.
 *
 * That last name is why this is not a tidy-up. voxtral is the model whose
 * doc comment in isLikelyChatModel records the 2026-08-10 incident: every
 * remediation run for the whole 20-app fleet routed to Mistral's AUDIO family,
 * which was handed tool definitions and asked to propose code fixes. The fix
 * at the time widened the denylist, which worked for `mistral/voxtral-*`
 * because Mistral's own catalog publishes no modality field. The IDENTICAL
 * model reached through OpenRouter publishes `output_modalities: ["text"]`
 * (true — it transcribes audio INTO text), so chatCapable came back true, the
 * denylist was skipped, and the documented incident stayed reachable through a
 * second door for a month.
 *
 * So the denylist is now absolute, which is what the two hand-carved vetoes
 * already were — one rule instead of a general principle plus a growing list
 * of exceptions to it, each added after something broke.
 *
 * WHAT THIS COSTS, stated rather than buried: a future chat model whose name
 * trips a pattern can no longer be rescued by its vendor's catalog. That cost
 * is real and it is the right trade. The denylist is deliberately narrow and
 * currently produces zero false positives across the entire live catalog; the
 * failure it prevents is a fleet-wide outage where an audio model silently
 * becomes the agent runtime's model of choice, and the failure it can cause is
 * that the router picks a different chat model. Those are not comparable.
 *
 * A vendor NEGATIVE still wins, unchanged: `chatCapable: false` excludes a
 * model the denylist would have kept. There is no measured case of the two
 * disagreeing in that direction, and a vendor saying its own model does not
 * emit text is answering exactly the question asked.
 */
export function resolveChatCapable(model: {
  id: string;
  chatCapable?: boolean;
}): boolean {
  if (!isLikelyChatModel(model.id)) return false;
  if (isFillInMiddleModel(model.id) || isSafetyClassifierModel(model.id)) return false;
  return model.chatCapable ?? true;
}

/**
 * "No price on file", as a sortable number.
 *
 * Deliberately absurd so an unpriced candidate sorts LAST in the price-ordered
 * comparators, where it is only ever separating two candidates already tied on
 * everything that matters. It is NOT a cost estimate and must never be
 * multiplied by anything — see UNKNOWN_COST_PER_MTOK.
 */
export const NO_PRICE_SENTINEL = 1_000_000;

/**
 * What an unpriced candidate is ASSUMED to cost when a weighted blend needs a
 * number rather than an ordering.
 *
 * Sized above the dearest thing this platform would really route to (a frontier
 * pair runs roughly $200/MTok in and out combined), so an unknown price is
 * treated as "probably the most expensive option here" — a real penalty that
 * still leaves the candidate reachable when it is the only one that fits.
 *
 * The alternative, which is what happened before, is multiplying the SENTINEL:
 * at the balanced 0.01 rate that is a flat -10,000 against an intelligence term
 * worth at most ~125, i.e. an 80x veto. That is an absolute exclusion produced
 * by arithmetic rather than by a rule, it is invisible in the explain output,
 * and it silently prevents the cost path's own documented policy for unpriced
 * calls (bill at the fallback ceiling, raise an ERROR, record
 * costBasis='unpriced') from ever running.
 */
const UNKNOWN_COST_PER_MTOK = 250;

function costScore(cost: number | null): number {
  if (typeof cost !== 'number' || Number.isNaN(cost) || !Number.isFinite(cost)) {
    return NO_PRICE_SENTINEL;
  }
  return cost;
}



/**
 * What share of this candidate's input will be served from cache.
 *
 * MEASURED FIRST, declared second. An observed hit rate is what this exact
 * (provider, model) pair actually did with real traffic; the caller's declared
 * prefix size is a property of the prompt, which two providers can answer
 * completely differently. Where both exist the measurement wins — it already
 * accounts for everything the estimate cannot see: cache TTL, minimum prefix
 * length, replica affinity, and whether the vendor caches at all.
 *
 * Returns null when neither is usable, which leaves the candidate priced
 * uncached — the honest answer to "we cannot say this is cheaper".
 */
function cachedFractionFor(
  candidate: AiRouterCandidate,
  cacheContext?: { cacheablePrefixTokens?: number; estimatedPromptTokens?: number },
): number | null {
  const observed = candidate.observedCacheHitRate;
  const eligible = candidate.observedCacheEligibleTokens ?? 0;
  if (
    typeof observed === 'number' &&
    Number.isFinite(observed) &&
    observed >= 0 &&
    eligible >= MIN_CACHE_OBSERVATION_TOKENS
  ) {
    return Math.min(1, observed);
  }

  const prefix = cacheContext?.cacheablePrefixTokens;
  const prompt = cacheContext?.estimatedPromptTokens;
  if (
    typeof prefix !== 'number' ||
    !Number.isFinite(prefix) ||
    prefix <= 0 ||
    typeof prompt !== 'number' ||
    !Number.isFinite(prompt) ||
    prompt <= 0
  ) {
    return null;
  }
  // BELOW THE VENDOR'S MINIMUM, NOTHING CACHES. A model that supports prompt
  // caching still refuses to cache a prefix shorter than its own threshold, so
  // claiming the cache-read rate for one is inventing a discount the vendor
  // will not grant — the same shape as the long-context tier pricing that
  // under-billed roughly half of 385 models before it was found.
  //
  // Only a KNOWN minimum can withdraw the discount. An absent one means "no
  // minimum on file", never "assume the worst", or a silent feed would start
  // repricing models that genuinely do cache.
  const minPrefix = candidate.promptCacheMinTokens;
  if (typeof minPrefix === 'number' && Number.isFinite(minPrefix) && prefix < minPrefix) {
    return null;
  }
  // Clamped: a caller whose prefix estimate exceeds its prompt estimate has
  // given us two numbers that cannot both be right, and the safe reading is
  // "the whole prompt is prefix" rather than a fraction above 1 that would
  // discount tokens that do not exist.
  return Math.min(1, prefix / prompt);
}

/**
 * Eligible prompt tokens a pair must have accumulated before its measured hit
 * rate outranks the caller's estimate.
 *
 * Tokens rather than call count, because that is what the rate is a ratio of:
 * fifty tiny calls say much less about a prefix than one large one. Set low —
 * roughly a handful of real prompts — since even a coarse measurement of this
 * pair beats a precise estimate about a different one.
 */
const MIN_CACHE_OBSERVATION_TOKENS = 50_000;

/**
 * Per-MTok cost with the cacheable slice of the prompt priced at this
 * candidate's CACHE-READ rate rather than its base input rate.
 *
 * Returns the plain estimate untouched unless every input is present and
 * usable — a missing cached rate, a missing prefix size, or a prompt estimate
 * of zero all mean "we cannot say this is cheaper", and the honest answer to
 * that is the uncached number, not an optimistic one.
 *
 * Only the INPUT half is discounted. Caching does nothing for generated
 * tokens, and applying the discount to the whole figure would under-price
 * exactly the models with expensive output.
 */
export function effectiveCostPerMTok(
  candidate: AiRouterCandidate,
  cacheContext?: { cacheablePrefixTokens?: number; estimatedPromptTokens?: number },
): number | null {
  const base = candidate.estimatedCostPerMTok;
  if (typeof base !== 'number' || !Number.isFinite(base)) return base ?? null;

  const cachedRate = candidate.cachedInputCostPerMTok;
  const inputRate = candidate.inputCostPerMTok;
  if (
    typeof cachedRate !== 'number' ||
    !Number.isFinite(cachedRate) ||
    typeof inputRate !== 'number' ||
    !Number.isFinite(inputRate)
  ) {
    return base;
  }

  const cachedFraction = cachedFractionFor(candidate, cacheContext);
  if (cachedFraction === null) return base;
  const effectiveInput = cachedRate * cachedFraction + inputRate * (1 - cachedFraction);
  // Rebuild rather than scale: `base` is input + output, so swapping the input
  // term out keeps the output term at full price where it belongs.
  return Math.max(0, base - inputRate + effectiveInput);
}

/**
 * Fallback neutral latency for a candidate with no observed average yet (never
 * routed to, or its 24h window lapsed), used only when the pool being ranked
 * cannot supply a middle of its own.
 *
 * MID-PACK IS THE INTENT AND 3s IS NOT MID-PACK. A brand-new candidate should
 * not outrank a PROVEN-fast one on the strength of having no data — that would
 * make "never tried" a strategy — but it must not be penalized as if it were
 * confirmed slow either, or a newly configured model can never win a ranking
 * until something else routes to it first. That reasoning is right and the
 * number stopped matching it: MEASURED against HuggingFace's live router
 * catalog on 2026-09-09, 135 models carry a vendor-measured first-token
 * latency with a median of 649ms and a maximum of 3,458ms. 3,000ms sits near
 * the 95th percentile of what real endpoints actually do, so "unknown" was
 * being scored as one of the slowest things on the table. At the auto family's
 * latency weight of 2, that is a standing ~4.7-point penalty on every candidate
 * nobody has measured yet — larger than the penalty a maximally expensive model
 * pays, and applied for having no evidence rather than bad evidence.
 *
 * So the neutral is now the pool's own median measured latency, which makes
 * mid-pack true by construction instead of aspirational, and keeps being true
 * as endpoints get faster without anyone maintaining a number. Same reasoning
 * and same shape as poolReferenceThroughput below; see its doc comment for why
 * a pool median is right for a speed signal and stays wrong for the quality
 * factors it sits beside.
 *
 * This constant survives for the degenerate case: a pool with fewer than
 * MIN_LATENCY_REFERENCE_SAMPLES measured candidates has no middle to find.
 */
const NEUTRAL_LATENCY_MS = 3_000;

/** Below this many measured candidates, the pool cannot define its own middle.
 *  Three is the smallest count where a median is a middle rather than a
 *  restatement of one reading — same threshold, same reason, as throughput. */
const MIN_LATENCY_REFERENCE_SAMPLES = 3;

/**
 * The latency that scores neutral for THIS ranking: the median of what the
 * candidates on the table were actually measured at.
 *
 * Exported so the choice is testable on its own, and null when the pool is too
 * small to have a middle, in which case callers fall back to NEUTRAL_LATENCY_MS.
 */
/**
 * The middle of what a pool was actually measured at, or null when it is too
 * small to have one.
 *
 * ONE implementation for both speed references below. They arrived a commit
 * apart and were the same twelve lines twice — collect the fused readings, drop
 * the pairs nobody has measured, take the median, refuse to invent one from
 * fewer than three. Only the extractor differed, so only the extractor is a
 * parameter.
 *
 * `minSamples` is 3 for both callers and named rather than inlined because it
 * is a judgement, not an accident: three is the smallest count where a median
 * is a middle rather than a restatement of one reading.
 */
function poolMedian(
  candidates: readonly AiRouterCandidate[],
  observe: (candidate: AiRouterCandidate) => number | null,
  minSamples: number,
): number | null {
  const observed = candidates
    .map(observe)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (observed.length < minSamples) return null;
  const mid = Math.floor(observed.length / 2);
  return observed.length % 2 === 1 ? observed[mid]! : (observed[mid - 1]! + observed[mid]!) / 2;
}

export function poolReferenceLatency(
  candidates: readonly AiRouterCandidate[],
): number | null {
  return poolMedian(
    candidates,
    (c) =>
      fuseEvidence([
        {
          value: typeof c.avgLatencyMs === 'number' ? Math.max(0, c.avgLatencyMs) : null,
          weight: FIRST_PARTY_FULL_WEIGHT,
        },
        {
          value: typeof c.externalLatencyMs === 'number' ? Math.max(0, c.externalLatencyMs) : null,
          weight: EXTERNAL_FEED_WEIGHT,
        },
      ]),
    MIN_LATENCY_REFERENCE_SAMPLES,
  );
}

function latencyScore(
  avgLatencyMs: number | null | undefined,
  externalLatencyMs?: number | null,
  latencySampleCount?: number | null,
  referenceLatencyMs?: number | null,
): number {
  // WEIGHTED, not vetoed. Our EWMA used to win outright the instant it had any
  // samples at all, so a single unlucky first request permanently displaced a
  // feed built from thousands of observations of the same pair. It still leads —
  // that is what the weight is for — but only in proportion to how much of it
  // there is, and the external measurement always contributes.
  //
  // Sample count is optional: a caller that cannot supply one gets the full
  // first-party weight, which is the pre-existing behaviour for every candidate
  // source that does not track it.
  const fused = fuseEvidence([
    {
      value: typeof avgLatencyMs === 'number' ? Math.max(0, avgLatencyMs) : null,
      weight:
        latencySampleCount === undefined || latencySampleCount === null
          ? FIRST_PARTY_FULL_WEIGHT
          : sampleWeight(latencySampleCount, LATENCY_TRUSTED_SAMPLES, FIRST_PARTY_FULL_WEIGHT),
    },
    {
      value: typeof externalLatencyMs === 'number' ? Math.max(0, externalLatencyMs) : null,
      weight: EXTERNAL_FEED_WEIGHT,
    },
  ]);
  if (fused !== null) return fused;
  return typeof referenceLatencyMs === 'number' && referenceLatencyMs >= 0
    ? referenceLatencyMs
    : NEUTRAL_LATENCY_MS;
}

/** The mode-level rationale shown to the admin — shared by selectRouterCandidate
 *  and by callers that pick from rankRouterCandidates themselves (e.g. a
 *  fallback loop) and need the same "why this mode chose this" text. */
export function reasonFor(mode: AiRoutingStrategy, normalizedPreferred?: string): string {
  if (mode === 'budget') {
    return 'Budget mode selected the cheapest access tier, then the cheapest priced model in it.';
  }
  if (mode === 'frontier') {
    return 'Frontier mode prioritized the strongest intelligence tier while keeping the cheapest option in that tier.';
  }
  if (mode === 'auto') {
    return 'Auto mode balanced intelligence versus cost and preferred free or low-cost coverage.';
  }
  if (mode === 'auto-budget') {
    return 'Auto-budget mode blended the same evidence as auto, tilted toward cheap and included access, while still letting capability decide between similarly-priced options.';
  }
  if (mode === 'auto-frontier') {
    return 'Auto-frontier mode blended the same evidence as auto, tilted toward the strongest capability, while still letting a nearly-as-capable free or low-cost option win over a needlessly expensive one.';
  }
  return normalizedPreferred
    ? 'Exact model preference resolved to the most suitable available provider and model.'
    : 'Explicit mode used the selected provider/model directly.';
}

/** Score every candidate on the four terms the comparator below reads, plus
 *  the single composite number 'auto' mode blends them into (null for every
 *  other mode, which ranks lexicographically over these terms instead of
 *  blending them — see `compareScored`). This is a pure function of ONE
 *  candidate; it does not know about `mode`'s tie-break ORDER, only about
 *  what each term IS. */
/**
 * Ranking inputs that describe THIS REQUEST rather than the candidates.
 *
 * Kept as one object so a third request-shaped input does not mean a fourth
 * positional argument on three exported functions.
 */
export interface AiRouterRankContext {
  /** Rough prompt size in tokens; drives context-window eligibility. */
  /**
   * Best-effort ACTUAL prompt size in tokens — see filterByContextWindow's doc
   * for the two consumers and why this must not be inflated "to be safe".
   */
  estimatedPromptTokens?: number;
  /**
   * This request is generation-heavy — a long answer rather than a short
   * decision — so observed tokens/second is a meaningful ranking input.
   *
   * Opt-in because it is only true sometimes. For a planner step deciding
   * which tool to call, wall clock is what matters and throughput is noise;
   * for a final answer or a patch, the reverse.
   */
  preferThroughput?: boolean;
  /**
   * How many of this request's prompt tokens are a STABLE prefix that a
   * prompt cache can serve — the invariant instruction block plus tool
   * definitions, not the per-request payload.
   *
   * When supplied together with `estimatedPromptTokens`, the cost term below
   * prices that slice at each candidate's CACHE-READ rate instead of its base
   * input rate. Without it, ranking prices every call as a cold start, which
   * systematically over-states the cost of exactly the models that cache
   * cheapest — so the ranker can pick a nominally cheaper model that is
   * actually dearer over a multi-turn run.
   *
   * STEADY STATE, stated rather than hidden: this models turns 2..N, where the
   * prefix is already resident. Turn 1 pays a write premium instead. That is
   * the right thing to optimise for on a task that loops, and it is why this
   * is opt-in per caller rather than applied everywhere — a genuinely
   * single-shot task should not pass it.
   */
  cacheablePrefixTokens?: number;
}

function scoreOne(
  candidate: AiRouterCandidate,
  preferThroughput = false,
  cacheContext?: { cacheablePrefixTokens?: number; estimatedPromptTokens?: number },
  referenceThroughput: number | null = null,
  referenceLatency: number | null = null,
): Omit<AiRouterCandidateScore, 'candidate' | 'compositeScore'> {
  return {
    accessRank: ACCESS_RANK[candidate.accessClass],
    cost: costScore(effectiveCostPerMTok(candidate, cacheContext)),
    intelligence: intelligenceWithReliability(candidate, preferThroughput, referenceThroughput),
    latencyMs: latencyScore(
      candidate.avgLatencyMs,
      candidate.externalLatencyMs,
      undefined,
      referenceLatency,
    ),
  };
}

/**
 * The four coefficients `autoComposite` blends with — one named preset per
 * auto-family strategy. All three keep the exact same FORMULA SHAPE (a
 * linear blend of intelligence, accessRank, costPenalty, and latency — see
 * `autoComposite` below); only the weights move. That constraint matters:
 * a structurally different formula per preset would make "auto-budget" and
 * "auto-frontier" a genuinely different algorithm from 'auto' rather than
 * the same judgment tilted toward a different point on the cost↔capability
 * dial, which is the whole product ask.
 *
 * `balanced` is 'auto' — copied verbatim from the coefficients this file has
 * always used (intelligence×1.25, accessRank×10, costPenalty rate 0.01,
 * latency×2). NOT allowed to move: anything already relying on 'auto''s
 * exact ranking behavior must see zero change.
 *
 * `budgetLeaning` ('auto-budget') roughly HALVES the intelligence weight
 * (1.25 → 0.6) and roughly DOUBLES both the accessRank weight (10 → 16, a
 * ~60% bump) and the cost-penalty rate (0.01 → 0.02) relative to balanced —
 * cost and included-access-tier now dominate the blend the way they do for
 * literal 'budget' mode's primary sort key, but intelligence is still worth
 * real points, not reduced to a mere tiebreak: two similarly-cheap
 * candidates with a real capability gap (say, a 20-point agentic_index
 * difference) still separate by ~12 composite points at 0.6 weight — smaller
 * than balanced's ~25, but nowhere near zero, which is exactly what keeps
 * this a genuine blend instead of literal 'budget' mode's rigid cost-primary
 * sort (where intelligence only ever breaks an EXACT cost tie). Latency
 * weight is left unchanged: a budget-conscious caller still doesn't want a
 * dramatically slower model just because it's marginally cheaper, and
 * latency was never the axis this preset is meant to move.
 *
 * `frontierLeaning` ('auto-frontier') roughly DOUBLES the intelligence
 * weight (1.25 → 2.5) and roughly HALVES both the accessRank weight (10 → 6)
 * and the cost-penalty rate (0.01 → 0.005) relative to balanced —
 * capability now dominates the blend the way it does for literal 'frontier'
 * mode's primary sort key, but cost/access still meaningfully move the
 * score: at 0.005 per estimated-cost-per-MTok-dollar-cent-equivalent unit, a
 * free-tier or cheap candidate within a few intelligence points of a
 * needlessly expensive metered one can still come out ahead once the
 * expensive one's cost penalty and access-rank cost stack up — literal
 * 'frontier' mode would never let that happen, since cost there only ever
 * breaks an EXACT intelligence tie. Latency weight is left unchanged for the
 * same reason as budgetLeaning: it was never the axis either preset is
 * meant to move, and a big latency swing should keep mattering the same
 * amount no matter which end of the cost↔capability dial the caller leans
 * toward.
 */
const AUTO_COMPOSITE_WEIGHTS: Record<
  'auto' | 'auto-budget' | 'auto-frontier',
  { intelligence: number; accessRank: number; costPenaltyRate: number; latency: number }
> = {
  auto: { intelligence: 1.25, accessRank: 10, costPenaltyRate: 0.01, latency: 2 },
  'auto-budget': { intelligence: 0.6, accessRank: 16, costPenaltyRate: 0.02, latency: 2 },
  'auto-frontier': { intelligence: 2.5, accessRank: 6, costPenaltyRate: 0.005, latency: 2 },
};

/** The auto-family's blended composite — the ONE place this formula is
 *  written, parameterized by which of the three named weight presets
 *  (AUTO_COMPOSITE_WEIGHTS above) to blend with. Defaults to 'auto' (the
 *  balanced preset, i.e. this function's original pre-auto-family behavior)
 *  so existing call sites that never pass a mode keep working unchanged.
 *
 *  Latency in whole seconds so its weight is comparable to the other terms:
 *  at the shared latency×2 weight, a candidate answering 10s slower loses
 *  ~20 points, roughly one intelligence tier's worth of movement — enough to
 *  matter, not enough for a merely-average-latency frontier model to lose to
 *  a fast-but-weak one.
 *
 *  Cost only enters the blend for metered/unknown access — subscription and
 *  free-tier candidates cost the caller nothing PER CALL (the whole point of
 *  accessRank's negative spread already capturing that), so their own
 *  estimatedCostPerMTok is either the underlying metered-equivalent rate
 *  (irrelevant — not what gets billed) or absent entirely. `costScore`
 *  returns a sentinel 1_000_000 for "no price on file", which is correct as
 *  budget/frontier's TIEBREAK (sort by accessRank/intelligence first, so the
 *  sentinel only ever separates two already-tied candidates) but is fatal
 *  here: at balanced's 0.01 rate it is a flat -10,000, dwarfing every other
 *  term (and worse at budgetLeaning's steeper 0.02). Observed live:
 *  subscription flagships with no per-token price (OAuth plans simply don't
 *  have one — anthropic/claude-sonnet-4-5, openai/gpt-5.6) scored around
 *  -9,878 despite tier-110 intelligence, guaranteeing they lose to any
 *  priced free-tier candidate no matter the intelligence gap. */
/**
 * Headroom below which a provider's remaining rate-limit budget starts to
 * count against it. Above this, normal healthy variance (60% left vs 95% left)
 * says nothing useful about whether the next call will succeed, and treating it
 * as a signal would just add noise to every ranking.
 */
const RATE_LIMIT_PRESSURE_THRESHOLD = 0.25;

/** Floor on the discount, so this stays a deprioritization and never a ban —
 *  the same "nudge not ban" posture as the refusal and uptime discounts. A
 *  provider with almost nothing left is still reachable if it is the only
 *  candidate that fits. */
const MIN_RATE_LIMIT_FACTOR = 0.5;



/**
 * Fallback reference generation rate, tokens/second, used only when the pool
 * being ranked cannot supply one of its own.
 *
 * WHY IT IS A FALLBACK NOW, AND NOT THE RULE. This was the rule, and it did
 * not work: a fixed reference makes the factor an ABSOLUTE judgement about
 * fast-vs-slow, and the absolute it was anchored to went stale. With the band
 * below (0.8x to 1.25x), a constant 50 means the whole discriminating range is
 * 40-62.5 tok/s. Every reading this platform actually collects sits above it —
 * a mainstream hosted model today generates well past 100 tok/s, and the
 * endpoint-health feed routinely reports three figures — so every measured
 * candidate pinned to MAX_THROUGHPUT_FACTOR and the signal separated nothing.
 * A 70 tok/s model and a 400 tok/s model scored identically, which is the exact
 * opposite of what the caller asked for by setting `preferThroughput`.
 *
 * WHY A POOL MEDIAN IS RIGHT HERE AND WRONG FOR QUALITY. EXPECTED_SUCCESS_RATE
 * and friends above argue explicitly against pool medians, and that argument
 * still holds — for them. A success rate has an absolute standard of good, so
 * letting the pool define "expected" would let a fleet-wide degradation quietly
 * redefine it downward and nothing would ever score badly again. Throughput has
 * no such standard: there is no rate that is simply "bad", only rates that are
 * slower than the alternatives on the table. The question `preferThroughput`
 * asks is comparative by construction — "of the models I could send this
 * generation to, which one produces fastest" — so the honest reference is the
 * pool being chosen from, and it stays correct at any era's speeds without
 * anyone maintaining a number.
 *
 * This constant survives for the degenerate case only: a pool with fewer than
 * MIN_THROUGHPUT_REFERENCE_SAMPLES measured candidates has no median worth the
 * name, and comparing one or two readings against themselves would say more
 * about the sample than the models.
 */
const REFERENCE_TOKENS_PER_SECOND = 50;

/** Below this many measured candidates, the pool cannot define its own middle
 *  and the fixed fallback above is used instead. Three is the smallest count
 *  where a median is a middle rather than a restatement of one reading. */
const MIN_THROUGHPUT_REFERENCE_SAMPLES = 3;

/** Bounds on the throughput adjustment. Deliberately narrow: throughput is a
 *  real signal but a secondary one, and a model that generates twice as fast
 *  is not twice as good a choice. */
const MIN_THROUGHPUT_FACTOR = 0.8;
const MAX_THROUGHPUT_FACTOR = 1.25;

/**
 * Multiplier applied while a vendor declares a major incident.
 *
 * Steep enough that any comparable alternative wins, shallow enough that a
 * candidate with no alternative is still reachable — the same "nudge not ban"
 * posture as every other discount in this file, and for a sharper reason here:
 * the signal is the vendor's own summary of its whole platform, which can be
 * red for something that does not touch the endpoint we are about to call.
 */
const VENDOR_INCIDENT_FACTOR = 0.35;

/**
 * Capability multiplier for observed generation rate, applied ONLY to
 * generation-heavy requests.
 *
 * 1.0 (no effect) when unmeasured, which is the overwhelmingly common case and
 * must stay neutral — "never generated enough to measure" is not "slow".
 */
function fusedThroughput(candidate: AiRouterCandidate): number | null {
  // Both readings count. Our own EWMA used to win outright over the feed; it now
  // leads by weight, so a pair we have measured once is not treated as more
  // authoritative than an aggregator that has measured it continuously.
  const own = candidate.throughputTokensPerSecond;
  const external = candidate.externalThroughputTps;
  return fuseEvidence([
    {
      value: typeof own === 'number' && own > 0 ? own : null,
      weight: FIRST_PARTY_FULL_WEIGHT,
    },
    {
      value: typeof external === 'number' && external > 0 ? external : null,
      weight: EXTERNAL_FEED_WEIGHT,
    },
  ]);
}

/**
 * The generation rate that scores neutral for THIS ranking: the median of what
 * the candidates on the table were actually measured to produce.
 *
 * Exported so the choice is testable on its own, and null whenever the pool is
 * too small to have a middle — callers fall back to REFERENCE_TOKENS_PER_SECOND,
 * whose doc comment explains why that is a last resort rather than the rule.
 */
export function poolReferenceThroughput(
  candidates: readonly AiRouterCandidate[],
): number | null {
  return poolMedian(candidates, fusedThroughput, MIN_THROUGHPUT_REFERENCE_SAMPLES);
}

function throughputFactor(
  candidate: AiRouterCandidate,
  referenceTokensPerSecond: number | null,
): number {
  const observed = fusedThroughput(candidate);
  if (observed === null) return 1;
  const reference =
    referenceTokensPerSecond !== null && referenceTokensPerSecond > 0
      ? referenceTokensPerSecond
      : REFERENCE_TOKENS_PER_SECOND;
  const ratio = observed / reference;
  return Math.max(MIN_THROUGHPUT_FACTOR, Math.min(MAX_THROUGHPUT_FACTOR, ratio));
}

function autoComposite(s: AiRouterCandidateScore, mode: 'auto' | 'auto-budget' | 'auto-frontier' = 'auto'): number {
  const weights = AUTO_COMPOSITE_WEIGHTS[mode];
  // The sentinel is an ORDERING, not a price. Blending it multiplies a made-up
  // 1,000,000 by a real rate and produces a veto nobody wrote down; an assumed
  // dear price produces a penalty proportionate to every other term.
  const blendCost = s.cost >= NO_PRICE_SENTINEL ? UNKNOWN_COST_PER_MTOK : s.cost;
  const costPenalty =
    s.candidate.accessClass === 'metered' || s.candidate.accessClass === 'unknown'
      ? blendCost * weights.costPenaltyRate
      : 0;
  return (
    s.intelligence * weights.intelligence -
    s.accessRank * weights.accessRank -
    costPenalty -
    (s.latencyMs / 1000) * weights.latency
  );
}

/** Best-first comparator over precomputed scores — the single source of
 *  truth both `rankRouterCandidates` (existing callers, unchanged shape) and
 *  `rankRouterCandidatesWithScores` (the new explain-everything caller) sort
 *  with, so the two can never silently disagree on order. */
function compareScored(mode: AiRoutingStrategy, a: AiRouterCandidateScore, b: AiRouterCandidateScore): number {
  if (mode === 'budget') {
    // Cheapest access tier first, then cheapest actual price — cost is
    // budget mode's whole point, so it has to be the primary key, not a
    // tiebreak. Intelligence, then live latency, decide ties at equal cost.
    if (a.accessRank !== b.accessRank) return a.accessRank - b.accessRank;
    if (a.cost !== b.cost) return a.cost - b.cost;
    return (
      b.intelligence - a.intelligence ||
      a.latencyMs - b.latencyMs ||
      a.candidate.model.localeCompare(b.candidate.model)
    );
  }

  if (mode === 'frontier') {
    if (a.intelligence !== b.intelligence) return b.intelligence - a.intelligence;
    if (a.accessRank !== b.accessRank) return a.accessRank - b.accessRank;
    return a.cost - b.cost || a.latencyMs - b.latencyMs || a.candidate.model.localeCompare(b.candidate.model);
  }

  if (isAutoFamily(mode)) {
    // 'auto' / 'auto-budget' / 'auto-frontier' all take this SAME blended-
    // composite path — only the weight preset `autoComposite` blends with
    // differs (see AUTO_COMPOSITE_WEIGHTS). This is the one place that
    // distinction is made: everything else about how the composite is used
    // to rank (best-first, cost/latency/name tiebreak on an exact tie) is
    // shared across all three.
    const aScore = a.compositeScore ?? autoComposite(a, mode);
    const bScore = b.compositeScore ?? autoComposite(b, mode);
    if (aScore !== bScore) return bScore - aScore;
    return a.cost - b.cost || a.latencyMs - b.latencyMs || a.candidate.model.localeCompare(b.candidate.model);
  }

  // 'explicit' as a FALLBACK-CHAIN ranking (not a single named model — that path never ranks at
  // all) means "no smart preference beyond cost", the same deterministic floor 'budget' uses as
  // its own tiebreak, so an admin-pinned model's own fallback list still lands somewhere sane.
  // Live latency breaks cost ties before the final alphabetical floor.
  return a.cost - b.cost || a.latencyMs - b.latencyMs || a.candidate.model.localeCompare(b.candidate.model);
}

function filterByPreference(
  candidates: AiRouterCandidate[],
  preferredModel: string | undefined,
): AiRouterCandidate[] {
  const normalizedPreferred = preferredModel?.trim().toLowerCase();
  if (!normalizedPreferred) return candidates;
  const filtered = candidates.filter((candidate) => normalize(candidate.model).includes(normalizedPreferred));
  return filtered.length > 0 ? filtered : candidates;
}

/**
 * Headroom a candidate must leave beyond the estimated prompt, as a fraction
 * of its own window.
 *
 * A model whose window exactly equals the prompt has nowhere to put an answer.
 * 10% is a deliberately modest reserve: large enough that a candidate scraping
 * the limit is not chosen over one with real room, small enough that it never
 * excludes a model that would genuinely have worked.
 */
const CONTEXT_HEADROOM_FRACTION = 0.1;

/**
 * Drop candidates whose context window cannot hold the request.
 *
 * FAIL-OPEN, twice over, because both unknowns mean "no evidence of a
 * problem" rather than "problem":
 *   - a caller that does not estimate its prompt size filters nothing;
 *   - a candidate with no known window is never dropped, since an unknown
 *     window is not a small one.
 *
 * And if the filter would empty the pool entirely, the ORIGINAL pool is
 * returned instead. A request larger than every available model is a real
 * situation, and the honest response is to route it to the roomiest option and
 * let the prompt shaper do its job — not to fail the request outright, which is
 * strictly worse than the pre-existing behaviour this filter improves on.
 */
/**
 * CONSUMER 1 OF THE PROMPT-SIZE ESTIMATE: "can this model HOLD the request".
 *
 * Tolerant of over-reporting, and deliberately builds its own margin on top via
 * CONTEXT_HEADROOM_FRACTION — an inflated estimate here only leaves a model out
 * of the pool that might have squeezed it in, and the fail-open below catches
 * the case where that empties the pool.
 *
 * CONSUMER 2 lives in ai-router-candidates.ts: "will this PROVIDER ACCEPT a
 * request this size", against its published token bucket. That one is NOT
 * tolerant of over-reporting — an inflated number there removes the provider
 * outright, which is exactly how a 9,407-token estimate of a 4,789-token turn
 * excluded the only provider able to answer (2026-08-26).
 *
 * The two want OPPOSITE errors from one number, so the number must be ACCURATE
 * rather than conservative, and each consumer adds whatever margin it needs
 * itself. Anyone adding a third consumer: state which of the two you are.
 */
function filterByContextWindow(
  candidates: AiRouterCandidate[],
  estimatedPromptTokens: number | undefined,
): AiRouterCandidate[] {
  if (
    typeof estimatedPromptTokens !== 'number' ||
    !Number.isFinite(estimatedPromptTokens) ||
    estimatedPromptTokens <= 0
  ) {
    return candidates;
  }
  const fits = candidates.filter((candidate) => {
    const window = candidate.contextWindowTokens;
    if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return true;
    return estimatedPromptTokens <= window * (1 - CONTEXT_HEADROOM_FRACTION);
  });
  if (fits.length > 0) return fits;
  // Nothing fits. Rank by the most room available rather than dropping the
  // request — a copy, so the caller's array is never reordered in place.
  return [...candidates].sort(
    (a, b) => (b.contextWindowTokens ?? 0) - (a.contextWindowTokens ?? 0),
  );
}

/**
 * Every eligible candidate, ranked best-first for `mode`, WITH the score
 * breakdown that put it there — the "why" a canned per-mode sentence cannot
 * express (which candidates were even considered, and by how much the winner
 * actually won). `rankRouterCandidates` below is a thin projection of this
 * for the many callers that only ever wanted the candidate list.
 */
export function rankRouterCandidatesWithScores(
  candidates: AiRouterCandidate[],
  mode: AiRoutingStrategy,
  preferredModel?: string,
  estimatedPromptTokens?: number,
  context?: AiRouterRankContext,
): AiRouterCandidateScore[] {
  if (candidates.length === 0) return [];
  const preferThroughput = context?.preferThroughput ?? false;
  // Eligibility BEFORE preference, and both before scoring: "can this model
  // hold the request" is a harder constraint than "did the caller ask for this
  // family", and neither is a matter of degree that belongs in a score.
  const pool = filterByPreference(
    filterByContextWindow(candidates, estimatedPromptTokens),
    preferredModel,
  );
  // The neutral generation rate is a property of THIS pool, computed once from
  // the same eligible set being scored rather than per candidate — a candidate
  // must be measured against the alternatives it is actually competing with,
  // not against a number that predates them. Skipped entirely when the caller
  // did not ask for throughput, so no ranking pays for a signal it ignores.
  const referenceThroughput = preferThroughput ? poolReferenceThroughput(pool) : null;
  // The neutral latency is a property of THIS pool too, and unconditionally so:
  // unlike throughput, latency is scored on every request. A candidate nobody
  // has measured must sit in the middle of the models it is actually competing
  // with — that is what "unknown is not confirmed bad" means here.
  const referenceLatency = poolReferenceLatency(pool);
  const scored: AiRouterCandidateScore[] = pool.map((candidate) => {
    const base = scoreOne(
      candidate,
      preferThroughput,
      {
        cacheablePrefixTokens: context?.cacheablePrefixTokens,
        estimatedPromptTokens,
      },
      referenceThroughput,
      referenceLatency,
    );
    const withCandidate = { candidate, ...base, compositeScore: null };
    return { ...withCandidate, compositeScore: isAutoFamily(mode) ? autoComposite(withCandidate, mode) : null };
  });
  return scored.sort((a, b) => compareScored(mode, a, b));
}

/**
 * Every eligible candidate, ranked best-first for `mode`. Callers that need
 * resilience (auto/budget/frontier) should walk this list and fall back to
 * the next entry on failure, rather than trusting the top pick to always be
 * reachable — a router mode's whole promise is "give me AN answer", not
 * "give me this one specific model or nothing". Only `explicit` mode, where
 * the caller named one exact model, should fail on that model's own error.
 */
export function rankRouterCandidates(
  candidates: AiRouterCandidate[],
  mode: AiRoutingStrategy,
  preferredModel?: string,
  estimatedPromptTokens?: number,
  context?: AiRouterRankContext,
): AiRouterCandidate[] {
  return rankRouterCandidatesWithScores(
    candidates,
    mode,
    preferredModel,
    estimatedPromptTokens,
    context,
  ).map((s) => s.candidate);
}

/** Top-ranked candidate only — explicit mode, tests, and any caller that
 *  doesn't need fallback. Prefer `rankRouterCandidates` for auto/budget/frontier
 *  call sites so a failed top pick doesn't dead-end the whole request. */
export function selectRouterCandidate(
  candidates: AiRouterCandidate[],
  mode: AiRoutingStrategy,
  preferredModel?: string,
  estimatedPromptTokens?: number,
): AiRouterSelection | null {
  const ranked = rankRouterCandidates(candidates, mode, preferredModel, estimatedPromptTokens);
  const selected = ranked[0];
  if (!selected) return null;
  return {
    provider: selected.provider,
    model: selected.model,
    reason: reasonFor(mode, preferredModel?.trim().toLowerCase()),
  };
}

/** Async, pluggable decision-maker variant. When `ROUTER_DECISION_MAKER=typesafe` this
 *  will consult the TypeSafe Jev System One endpoint; otherwise falls back to the
 *  synchronous `selectRouterCandidate` behaviour. Use this where router latency and
 *  external decisioning is acceptable. */
export async function selectRouterCandidateDynamic(
  candidates: AiRouterCandidate[],
  mode: AiRoutingStrategy,
  preferredModel?: string,
  estimatedPromptTokens?: number,
  // Optional per-agent capability set; when provided, the router will only
  // consult an external decision-maker (like TypeSafe) if the agent has the
  // `analyze_env_remediation` capability enabled. This keeps routing behavior controllable per
  // agent without requiring global env changes.
  agentCapabilities?: readonly string[] | Set<string>,
): Promise<AiRouterSelection | null> {
  const maker = process.env.ROUTER_DECISION_MAKER || '';
  // Global router-level opt-out: operators can set ROUTER_DECISION_MAKER_ENABLED=false
  // to force local deterministic routing even when a decision-maker is configured.
  const makerEnabled = (process.env.ROUTER_DECISION_MAKER_ENABLED ?? 'true') !== 'false';

  if (maker && makerEnabled) {
    // If agent capabilities were supplied, require the per-agent `jev`
    // capability to be present before consulting the external decision-maker.
    if (agentCapabilities) {
      const hasJeV = Array.isArray(agentCapabilities)
        ? agentCapabilities.includes('analyze_env_remediation') || agentCapabilities.includes('jev')
        : (agentCapabilities as Set<string>).has('analyze_env_remediation') || (agentCapabilities as Set<string>).has('jev');
      if (!hasJeV) {
        return selectRouterCandidate(candidates, mode, preferredModel, estimatedPromptTokens);
      }
    }
    if (maker === 'typesafe') {
      try {
        const { decideWithTypesafe } = await import('./ai-decision-maker.js');
        const decision = await decideWithTypesafe({ candidates, mode, preferredModel, estimatedPromptTokens });
        if (decision && decision.provider && decision.model) return decision as AiRouterSelection;
      } catch (err) {
        // fall through to local deterministic pick
      }
    }
  }
  return selectRouterCandidate(candidates, mode, preferredModel, estimatedPromptTokens);
}

/**
 * Floor on the fraction of 'auto'-mode resolutions that deliberately pick an
 * under-sampled candidate instead of the top-ranked one. WHY THIS EXISTS:
 * every real-evidence signal in this file (trackRecordSuccessRate,
 * sustainRate, capabilityRefusalCount) only ever influences ranking once a
 * candidate has enough samples to trust — correct, per each signal's own
 * "absence is not evidence" contract, but it creates a cold-start trap on
 * its own: a candidate that starts out ranked low (say, on latency or cost
 * alone) gets picked rarely, and because it's picked rarely it never
 * accumulates the samples that could otherwise raise or confirm its
 * ranking. Rich-get-richer, purely from lack of chances — the model might
 * be perfectly fine. 5% is deliberately small: this trades a small, bounded
 * share of "best guess right now" for the platform's own ability to keep
 * learning, not a general randomization of routing.
 *
 * This is a FLOOR, not the whole story, because 5% was tuned against "a few
 * dozen" candidates. A flat rate spreads that same 5% budget across however
 * many under-explored candidates happen to be in the ranked list — with a
 * few dozen, each cold-start candidate gets picked every few requests; with
 * hundreds (this registry already lists 43 providers, and each can host many
 * models), the same 5% divided across a much bigger pool means any one
 * candidate's odds of getting an exploratory pick shrink toward
 * irrelevance — the exact starvation this mechanism exists to prevent, just
 * moved one level up. See `explorationRateFor` for how the effective rate
 * scales past this floor as the under-explored pool grows.
 */
export const EXPLORATION_RATE_FLOOR = 0.05;

/**
 * Ceiling on the effective exploration rate, regardless of how large the
 * under-explored pool gets. This is still live routing traffic for real user
 * requests — exploration must stay a small minority of it even at registry-
 * wide scale, or "learning about cold-start candidates" starts meaningfully
 * degrading normal-case answer quality, which defeats the purpose (a router
 * nobody trusts doesn't get to keep learning either). 3x the floor: enough
 * that a candidate in a huge pool gets meaningfully more frequent chances
 * than the diluted flat-5% baseline would give it, nowhere near "exploration
 * is now a routine fraction of traffic".
 */
export const EXPLORATION_RATE_CEILING = 0.15;

/**
 * Size of the under-explored pool that 5% (EXPLORATION_RATE_FLOOR) was
 * actually tuned against — "a few dozen" candidates, per the motivating case
 * above. Below this, the pool is the size the floor already accounts for, so
 * the rate stays flat at the floor: no reason to explore MORE aggressively
 * just because the pool is, say, 10 instead of 40 — small pools were never
 * the problem. Only past this reference point does dilution become real
 * enough to counteract.
 */
const UNDER_EXPLORED_REFERENCE_COUNT = 40;

/**
 * Effective exploration rate for a call with `underExploredCount`
 * under-explored candidates in its ranked list. Flat at the floor up to
 * `UNDER_EXPLORED_REFERENCE_COUNT`, then grows with the SQUARE ROOT of how
 * far past that reference the pool is — sublinear on purpose, so a huge
 * registry-wide pool (hundreds of models) pulls the rate up toward the
 * ceiling without a linear scale-up blowing past it almost immediately (a
 * linear "rate per candidate" term would need to be so small to respect the
 * ceiling at 300+ candidates that it would barely move at the 40-100
 * candidate range where the dilution first starts to bite). Clamped to
 * [EXPLORATION_RATE_FLOOR, EXPLORATION_RATE_CEILING] so neither bound is
 * ever crossed regardless of how the pool size moves.
 *
 * // example: 10 under-explored candidates  -> 5%    (below reference, floor)
 * // example: 40 under-explored candidates  -> 5%    (at reference, floor)
 * // example: 160 under-explored candidates -> ~10%  (4x reference -> sqrt(4)=2x floor)
 * // example: 360 under-explored candidates -> 15%   (9x reference -> sqrt(9)=3x floor, hits the ceiling)
 */
export function explorationRateFor(underExploredCount: number): number {
  if (underExploredCount <= UNDER_EXPLORED_REFERENCE_COUNT) return EXPLORATION_RATE_FLOOR;
  const scaled = EXPLORATION_RATE_FLOOR * Math.sqrt(underExploredCount / UNDER_EXPLORED_REFERENCE_COUNT);
  return Math.min(EXPLORATION_RATE_CEILING, scaled);
}

/**
 * A candidate this platform has real uncertainty about — no observed
 * dispatch track record AND no trusted sustain-rate sample (see
 * MIN_SUSTAIN_SAMPLES_TRUSTED). Both, not either: a candidate proven on one
 * axis but new on the other has SOME real evidence already and is not a
 * blank slate the way a candidate with neither is.
 */
function isUnderExplored(candidate: AiRouterCandidate): boolean {
  const noTrackRecord =
    candidate.trackRecordSuccessRate === undefined || candidate.trackRecordSuccessRate === null;
  const noSustainData =
    candidate.sustainSampleSize === undefined ||
    candidate.sustainSampleSize === null ||
    candidate.sustainSampleSize < MIN_SUSTAIN_SAMPLES_TRUSTED;
  return noTrackRecord && noSustainData;
}

/**
 * Given an already best-first ranked list, occasionally substitute the top
 * pick with the best-ranked UNDER-EXPLORED candidate instead of the actual
 * top pick — real exploration, not noise: among candidates this platform
 * has genuine uncertainty about, still take the one the REST of scoring
 * (cost, latency, access tier) likes best, so "let's learn about this one"
 * is never also "let's pick something obviously worse for no reason".
 *
 * Applies to any AUTO-FAMILY mode — 'auto', 'auto-budget', and
 * 'auto-frontier' alike. 'budget' and 'frontier' (the literal, blunt modes)
 * are an explicit user intent — cheapest, full stop; strongest, full stop —
 * and overriding either with an exploratory pick would violate the thing the
 * caller actually asked for: a repeatable, deterministic answer with zero
 * randomness involved. Every auto-family mode, by contrast, already means
 * "blend intelligence, cost, access, and latency into one judgment call",
 * just tilted toward a different point on the cost↔capability dial (see
 * AUTO_COMPOSITE_WEIGHTS) — exploration is a natural extension of that
 * judgment for all three, not a departure from it, so none of them are
 * exempted the way the literal modes are.
 *
 * Returns the ORIGINAL list, untouched, when: mode isn't an auto-family
 * mode, the roll misses, there is no under-explored candidate at all, or the
 * best under-explored candidate already IS the top pick (nothing to substitute).
 * When it does substitute, everyone else keeps their real relative order —
 * this is a promotion, not a re-sort, so a fallback chain behind the
 * exploratory pick is still the genuine ranking, not a shuffled one.
 *
 * `random` is injectable (default Math.random) so a caller can test this
 * deterministically instead of actually being nondeterministic in a test run.
 */
export function applyExploration<T extends AiRouterCandidate>(
  ranked: readonly T[],
  mode: AiRoutingStrategy,
  random: () => number = Math.random,
): { candidates: readonly T[]; explored: boolean } {
  if (!isAutoFamily(mode) || ranked.length <= 1) return { candidates: ranked, explored: false };
  const underExplored = ranked.filter((c) => isUnderExplored(c));
  if (underExplored.length === 0) return { candidates: ranked, explored: false };
  // Rate scales with THIS call's own under-explored pool, not the registry's
  // theoretical maximum — a request whose candidates happen to already be
  // well-sampled shouldn't get a scaled-up rate just because the platform
  // integrates many providers elsewhere. See explorationRateFor's doc for
  // the floor/ceiling reasoning.
  const rate = explorationRateFor(underExplored.length);
  if (random() >= rate) return { candidates: ranked, explored: false };
  const pick = underExplored[0];
  if (pick === ranked[0]) return { candidates: ranked, explored: false };
  const reordered = [pick, ...ranked.filter((c) => c !== pick)];
  return { candidates: reordered, explored: true };
}

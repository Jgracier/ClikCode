// ── AI EVIDENCE COMBINATION ──────────────────────────────────────────────────
// How the router turns several imperfect measurements of one thing into a single
// number, and how it turns a measurement into a score adjustment.
//
// Two rules live here, and both replace a habit the ranker had picked up in
// several places independently.
//
// ── RULE 1: NO SINGLE SOURCE IS THE ONLY SOURCE ──────────────────────────────
// The ranker used strict precedence in four places: first-party latency beat the
// external feed OUTRIGHT, first-party throughput beat the external feed
// OUTRIGHT, the agentic index beat the arena score OUTRIGHT, and the external
// uptime prior applied ONLY when no first-party track record existed at all.
// Each was justified the same way — "a real measurement of ours is better
// evidence than a third party's" — and each drew the wrong conclusion from it.
// Better evidence deserves more WEIGHT, not a veto. The old shape meant a single
// sample of our own silenced a feed built from thousands of observations, and
// one flapping first-party reading could not be moderated by anything.
//
// `fuseEvidence` weights instead of vetoing: a well-sampled first-party number
// still dominates (that is what its weight is for), but a second source always
// moves the result, and a first-party number with ONE sample behind it is
// correctly treated as the weak evidence it is.
//
// ── RULE 2: EVIDENCE MUST BE ABLE TO HELP, NOT ONLY HURT ─────────────────────
// Six of the seven capability multipliers were shaped
// `if (data present) capability *= factor` with `factor <= 1`, and absent data
// skipped the multiplication. So a measurement could only ever LOWER a score,
// and knowing nothing scored better than knowing something good.
//
// MEASURED 2026-08-26 on the real ranker, with candidates identical in access
// class, cost, context window, arena score and latency:
//     proven, fast throughput      composite = 101.62
//     never tried (no data)        composite =  92.95
//     proven, average throughput   composite =  81.14   <- 95% success rate
// A model with a 95% success rate, 92% sustain over 50 samples and 97% uptime
// ranked BELOW an identical model nobody had ever called. The platform explores
// under-sampled candidates on live user traffic, learns one is good, and then
// demotes it for having a record. Every signal added made the bias worse,
// because the penalties compound multiplicatively while nothing can offset them.
//
// `centeredFactor` fixes the asymmetry at its root: a factor is 1.0 when a
// measurement matches what a competent model is EXPECTED to do, above 1 when it
// beats that, below 1 when it misses. Absence still means "no adjustment", which
// now correctly reads as "assumed to perform as expected" rather than "assumed
// perfect".
//
// NOT EVERY SIGNAL IS SYMMETRIC, AND THAT IS DELIBERATE. Symmetry belongs to
// signals that measure QUALITY — how well a model performs. Signals that measure
// a CONSTRAINT (rate-limit headroom, a declared vendor incident) stay
// penalty-only: a provider with 95% of its quota free is not BETTER than one
// with 60% free, it is merely unconstrained, and paying it a bonus for idleness
// would rank an unused provider above a proven busy one. See the call sites.
// ─────────────────────────────────────────────────────────────────────────────

/** One source's reading of a quantity, with how much it should count. */
export interface EvidenceSource {
  value: number | null | undefined;
  /**
   * Relative confidence, > 0. Not a probability and not normalized — only the
   * RATIOS between the sources present matter, so a caller can express "ours
   * counts twice as much as theirs" as 1 and 0.5, or 2 and 1, interchangeably.
   */
  weight: number;
}

/**
 * Combine several readings of ONE quantity into a weighted mean.
 *
 * Sources with a non-finite value or a non-positive weight are ignored, so a
 * caller can pass every source it might have and let this decide. Returns null
 * when nothing usable was supplied — the caller then applies its own neutral
 * default, which stays the caller's decision rather than becoming a magic
 * number in here.
 */
export function fuseEvidence(sources: readonly EvidenceSource[]): number | null {
  let weighted = 0;
  let totalWeight = 0;
  for (const source of sources) {
    const { value, weight } = source;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) continue;
    weighted += value * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;
  return weighted / totalWeight;
}

/**
 * Confidence in a first-party measurement, scaled by how many samples back it.
 *
 * A first-party reading is the better source, but "better" is a function of how
 * much of it there is: one observation is an anecdote and three hundred is a
 * measurement, and the old outright-precedence treated them identically. Ramps
 * linearly to `full` at `trustedSamples` and never exceeds it, so a first-party
 * number cannot grow its own authority without bound.
 */
export function sampleWeight(
  sampleCount: number | null | undefined,
  trustedSamples: number,
  full: number,
): number {
  if (typeof sampleCount !== 'number' || !Number.isFinite(sampleCount) || sampleCount <= 0) {
    return 0;
  }
  if (trustedSamples <= 0) return full;
  return full * Math.min(1, sampleCount / trustedSamples);
}

export interface CenteredFactorBounds {
  /** Floor — the multiplier for a measurement far below expectation. */
  min: number;
  /** Ceiling — the multiplier for a measurement far above expectation. */
  max: number;
}

/**
 * Turn a measurement into a score multiplier CENTRED on what is expected, as a
 * ratio to that expectation.
 *
 * `observed / expected`, clamped. That shape is chosen over a piecewise ramp for
 * two reasons:
 *
 *  1. It KEEPS THE OLD SEVERITY. The previous code was `capability *= rate`,
 *     which reads as an expected-value discount — a model that succeeds 40% of
 *     the time delivers 40% of its benchmark value. That reading was correct and
 *     worth preserving; only its asymmetry was wrong. At the expected rate the
 *     ratio is 1, and below it the discount stays close to the old multiplier
 *     (0.4/0.9 = 0.44 against the old 0.40) instead of quietly halving the
 *     penalty for genuinely unreliable models.
 *  2. `observed === expected` returns exactly 1 — the same result as having no
 *     data at all. That equivalence is the point: "never measured" and "performs
 *     as expected" are the same claim about how something should rank, and the
 *     old shape made the first strictly better than the second.
 *
 * Above expectation earns a bounded bonus, which is the half that did not exist.
 */
export function centeredFactor(
  observed: number | null | undefined,
  spec: { expected: number } & CenteredFactorBounds,
): number {
  const { expected, min, max } = spec;
  if (typeof observed !== 'number' || !Number.isFinite(observed)) return 1;
  if (!Number.isFinite(expected) || expected <= 0) return 1;
  return Math.max(min, Math.min(max, observed / expected));
}

/**
 * A penalty-only factor, for signals that measure a CONSTRAINT rather than
 * quality — see this file's header for why those must not be symmetric.
 *
 * 1.0 while the measurement is at or above `comfortable`, falling toward `floor`
 * as it approaches zero. Kept here beside `centeredFactor` so the choice between
 * them is a visible decision at each call site rather than an accident of which
 * shape someone copied.
 */
export function constraintFactor(
  headroom: number | null | undefined,
  spec: { comfortable: number; floor: number },
): number {
  const { comfortable, floor } = spec;
  if (typeof headroom !== 'number' || !Number.isFinite(headroom)) return 1;
  if (headroom >= comfortable) return 1;
  if (comfortable <= 0) return 1;
  const ratio = Math.max(0, headroom) / comfortable;
  return floor + (1 - floor) * ratio;
}

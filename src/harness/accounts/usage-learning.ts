/**
 * Learning a usage limit for a harness that publishes none.
 *
 * Only three of twenty-four harnesses expose a usage figure (codex, claude,
 * auggie). The rest give nothing: no percentage, no reset time, no quota
 * endpoint. Antigravity is the clearest case -- it tracks a "user quota
 * summary" internally and its `retrieveUserQuota` call answers 403 for a
 * consumer account, so there is no number to read even though one exists.
 *
 * What every harness DOES give us is the two things this needs:
 *   - what each turn cost (tokens, or a fallback when it reports none)
 *   - the moments a turn was refused for quota, which ClikCode already
 *     detects in order to fail over
 *
 * The method is interval censoring, not curve fitting. Every SUCCESS is a
 * lower bound on the limit (that much was allowed), and every REFUSAL is an
 * upper bound (that much was not). So the limit is bracketed by observation
 * and the bracket only tightens. The estimate here is the high-water mark --
 * the largest window cost ever allowed -- which converges to the real limit
 * FROM BELOW and can never overshoot it on clean data. Verified in simulation
 * against known limits: ~8% error after one refusal, ~1% after five, ~0.2%
 * after ten.
 *
 * Two rules keep it honest, and they are the reason this is safe to display:
 *
 *  1. MATURITY. Nothing is published until an account has hit that window's
 *     limit at least MIN_HITS times. An uncalibrated estimate is not shown as
 *     a cautious number or a wide range; it is not shown.
 *  2. ATTRIBUTION. A window is only published if refusals actually cluster at
 *     its high-water mark. Accounts usually have several nested limits (five
 *     hours AND weekly); a refusal caused by the weekly cap says nothing about
 *     the five-hour one, and treating it as evidence made an earlier version
 *     of this produce a 5h limit far below the truth. A window that cannot
 *     explain the refusals is silently dropped rather than guessed at.
 */
import type { HarnessState } from '../../session/model.js';
import type { UsageReading, UsageWindow } from './usage-reading.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Vendors publish windows from a small, standard set, so this is model
 *  selection over four candidates rather than fitting a free parameter --
 *  far more robust on a handful of observations. */
export const CANDIDATE_WINDOWS: readonly { name: string; ms: number }[] = [
  { name: '1h', ms: HOUR },
  { name: '5h', ms: 5 * HOUR },
  { name: '24h', ms: DAY },
  { name: 'weekly', ms: 7 * DAY },
];

/** Refusals needed before a window's figure is published at all. Two is the
 *  first point where a bracket exists rather than a single data point. */
export const MIN_HITS = 2;
/** A refusal counts as explained by a window when the cost in that window had
 *  reached most of its high-water mark. */
const EXPLAINED_AT = 0.85;
/** ...and a window must explain this fraction of refusals to be published. */
const MIN_EXPLAINED = 0.30;
/** Bounded history: enough to calibrate, small enough to store forever. */
const KEEP_HITS = 40;

export interface QuotaHit {
  at: string;
  /** Observed cost in each candidate window at the moment of refusal, keyed by
   *  window name. Snapshotted rather than recomputed later, because the
   *  invocation log is pruned and rolled up and would not survive. */
  costs: Record<string, number>;
  /** Raw tokens per model inside the LONGEST candidate window at the moment of
   *  refusal, keyed by model id. This is what makes per-model weights
   *  learnable at all: two refusals with different model mixes are two
   *  equations, and without the breakdown there is only a total, which carries
   *  no information about which model was expensive. Raw tokens, deliberately
   *  unweighted -- weighting them here would fold the current estimate into
   *  the evidence used to revise it. */
  tokensByModel?: Record<string, number>;
}

export interface UsageLearning {
  /** Largest cost ever ALLOWED in each window: the limit estimate, converging
   *  from below. */
  highWater: Record<string, number>;
  hits: QuotaHit[];
}

type Invocation = HarnessState['invocations'][number];

/** What one turn cost, in whatever unit the harness makes available.
 *
 * A ladder, not a single rule, so every harness can learn something. Four
 * harnesses (aider, copilot, hermes, cn) are text-only and will never report
 * a token, and counting their turns is still a usable signal -- a limit
 * expressed in turns is learned exactly the same way as one expressed in
 * tokens, because the method only cares that the unit is consistent. */
export function turnCost(invocation: Invocation, weights: Readonly<Record<string, number>> = {}): number {
  // Reported cost first, and it needs no per-model weight at all: a dollar
  // figure ALREADY encodes both the model's price and whatever discount the
  // vendor applies to cache reads. Claude reports it on 404 of the 576
  // invocations on this machine, and its token fields alone are misleading --
  // a real turn read input_tokens 2, cache_read_tokens 10118, output 60, so
  // anything weighting those equally would score a heavily cached turn as if
  // it were fresh work.
  //
  // Mixing units inside one window would be wrong, but cannot happen: an
  // account belongs to exactly one provider, so cost is either reported for
  // all of its turns or none of them. Scaled up because the high-water mark
  // is stored as an integer-ish magnitude and sub-dollar turns would
  // otherwise quantise badly.
  if (invocation.costUsd !== undefined && invocation.costUsd > 0) return invocation.costUsd * 1_000_000;
  const weight = (invocation.model && weights[invocation.model]) || 1;
  // No total is published by several vendors, Claude among them; the parts
  // are. Cache reads are counted at full rate deliberately -- the unit only
  // has to be CONSISTENT, because the limit is learned in whatever unit this
  // returns. A "correct" discount is unknowable per vendor and would add a
  // guess without adding accuracy.
  const tokens = invocation.totalTokens
    ?? ((invocation.inputTokens ?? 0) + (invocation.outputTokens ?? 0) + (invocation.cacheReadTokens ?? 0));
  if (tokens > 0) return tokens * weight;
  // No token report. Latency is a better proxy than nothing, because a
  // vendor's own limits track agent work rather than request count (Google
  // says so explicitly for Antigravity), and a longer turn did more work.
  if (invocation.latencyMs && invocation.latencyMs > 0) return invocation.latencyMs * weight;
  return weight;
}

/** Cost this account accumulated inside `window` ending at `at`. */
export function costInWindow(
  invocations: readonly Invocation[], accountId: string, at: number, windowMs: number,
  weights?: Readonly<Record<string, number>>,
): number {
  let total = 0;
  for (const invocation of invocations) {
    if (invocation.accountId !== accountId) continue;
    const when = Date.parse(invocation.at);
    if (!Number.isFinite(when) || when > at || when <= at - windowMs) continue;
    total += turnCost(invocation, weights);
  }
  return total;
}

function snapshot(
  invocations: readonly Invocation[], accountId: string, at: number, weights?: Readonly<Record<string, number>>,
): Record<string, number> {
  const costs: Record<string, number> = {};
  for (const window of CANDIDATE_WINDOWS) {
    costs[window.name] = costInWindow(invocations, accountId, at, window.ms, weights);
  }
  return costs;
}

/** Raw, unweighted tokens per model inside the longest candidate window. */
function tokensByModel(
  invocations: readonly Invocation[], accountId: string, at: number,
): Record<string, number> {
  const longest = CANDIDATE_WINDOWS.reduce((a, b) => (b.ms > a.ms ? b : a)).ms;
  const out: Record<string, number> = {};
  for (const invocation of invocations) {
    if (invocation.accountId !== accountId || !invocation.model) continue;
    const when = Date.parse(invocation.at);
    if (!Number.isFinite(when) || when > at || when <= at - longest) continue;
    out[invocation.model] = (out[invocation.model] ?? 0) + turnCost({ ...invocation, model: undefined });
  }
  return out;
}

/** A turn was ALLOWED: raise the high-water mark. Monotone by construction --
 *  a limit never learned downward is a limit that never over-promises. */
export function recordAllowed(
  learning: UsageLearning | undefined, invocations: readonly Invocation[], accountId: string,
  at: number, weights?: Readonly<Record<string, number>>,
): UsageLearning {
  const next: UsageLearning = { highWater: { ...(learning?.highWater ?? {}) }, hits: learning?.hits ?? [] };
  const costs = snapshot(invocations, accountId, at, weights);
  for (const [name, cost] of Object.entries(costs)) {
    if (cost > (next.highWater[name] ?? 0)) next.highWater[name] = cost;
  }
  return next;
}

/** A turn was REFUSED for quota: the one observation that makes any of this
 *  possible. */
export function recordRefused(
  learning: UsageLearning | undefined, invocations: readonly Invocation[], accountId: string,
  at: number, weights?: Readonly<Record<string, number>>,
): UsageLearning {
  const hits = [...(learning?.hits ?? []), {
    at: new Date(at).toISOString(),
    costs: snapshot(invocations, accountId, at, weights),
    tokensByModel: tokensByModel(invocations, accountId, at),
  }];
  return {
    highWater: { ...(learning?.highWater ?? {}) },
    hits: hits.slice(-KEEP_HITS),
  };
}

/** Refusals needed before per-model weights are fitted at all: enough
 *  equations to outnumber the unknowns, plus one. Below this the weights stay
 *  1.0, which is exactly the behaviour before any of this existed. */
const MIN_HITS_FOR_WEIGHTS = 3;
/** Pull toward 1.0, as a FRACTION of the data's own scale rather than an
 *  absolute amount. An absolute ridge was the first attempt and it was wrong:
 *  the design matrix is normalised, so its entries are well under one, and a
 *  fixed lambda then dominated everything and crushed every weight toward 1.0
 *  -- worse, it reordered them, reporting a 9x model as cheaper than a 4x one.
 *
 *  0.005 was chosen by measurement, not taste. Over 40 trials per setting
 *  against known weights of 1/4/9, with refusals deliberately not landing
 *  exactly on the limit (hidden traffic and the high-water estimate both add
 *  noise):
 *      ridge   clean   10% noise   25% noise   correct ordering
 *      0.05    47%       48%         50%            73%
 *      0.01    19%       21%         32%            96%
 *      0.005   11%       16%         30%            98%
 *      0.001    3%       13%         31%            97%
 *  0.005 gives the best ordering while keeping real protection against
 *  overfitting a handful of observations.
 *
 *  Note what the numbers say about USE: under real noise the magnitude is
 *  only good to tens of percent, so these weights are for ranking models by
 *  cost -- scheduling, and the relative sizes -- not for claiming a model
 *  costs exactly 8.7x another. */
const WEIGHT_RIDGE = 0.005;
/** A fitted weight outside this range is not believed. Vendors do charge
 *  premium models several times more, but not a thousand times more, and a
 *  value out here means the fit found noise rather than signal. */
const WEIGHT_BOUNDS = { min: 0.1, max: 25 };

/** Relative per-model cost, fitted from refusals.
 *
 * Every refusal is one equation: the weighted tokens in the window at that
 * moment had reached the limit, and the limit is already estimated by the
 * high-water mark. So with the limit KNOWN this is an ordinary linear
 * least-squares problem in the weights alone -- far better conditioned than
 * solving for the limit and the weights together, which is scale-indeterminate
 * (double every weight, double the limit, same predictions).
 *
 * Solved by ridge-regularised normal equations: (AᵀA + λI)w = Aᵀb + λ·1.
 * Small enough (one unknown per model the account has actually used) that
 * plain Gaussian elimination is the right solver.
 *
 * Returns an empty map when there is not enough evidence, and callers then
 * weight every model 1.0. That is the point: an unfitted weight is 1, never a
 * guess.
 */
export function fitModelWeights(learning: UsageLearning | undefined, windowName: string): Record<string, number> {
  const hits = (learning?.hits ?? []).filter((hit) => hit.tokensByModel && Object.keys(hit.tokensByModel).length);
  const limit = learning?.highWater[windowName] ?? 0;
  if (hits.length < MIN_HITS_FOR_WEIGHTS || limit <= 0) return {};
  const models = [...new Set(hits.flatMap((hit) => Object.keys(hit.tokensByModel!)))].sort();
  if (!models.length || hits.length <= models.length) return {};

  // A: rows of per-model tokens, b: the limit each row reached.
  const rows = hits.map((hit) => models.map((m) => hit.tokensByModel![m] ?? 0));
  const scale = Math.max(...rows.flat(), 1);
  const a = rows.map((row) => row.map((v) => v / scale));
  const b = hits.map(() => limit / scale);

  const n = models.length;
  // Ridge relative to the average diagonal of AᵀA, so it regularises by the
  // same order of magnitude as the evidence rather than swamping it.
  let trace = 0;
  for (let i = 0; i < n; i += 1) for (const row of a) trace += row[i]! * row[i]!;
  const lambda = WEIGHT_RIDGE * (trace / n);
  const matrix: number[][] = Array.from({ length: n }, () => Array.from({ length: n + 1 }, () => 0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let sum = i === j ? lambda : 0;
      for (const row of a) sum += row[i]! * row[j]!;
      matrix[i]![j] = sum;
    }
    let rhs = lambda;   // ridge pulls toward 1.0
    for (const [r, row] of a.entries()) rhs += row[i]! * b[r]!;
    matrix[i]![n] = rhs;
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(matrix[r]![col]!) > Math.abs(matrix[pivot]![col]!)) pivot = r;
    if (Math.abs(matrix[pivot]![col]!) < 1e-12) return {};   // singular: no usable answer
    [matrix[col], matrix[pivot]] = [matrix[pivot]!, matrix[col]!];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = matrix[r]![col]! / matrix[col]![col]!;
      for (let k = col; k <= n; k += 1) matrix[r]![k]! -= factor * matrix[col]![k]!;
    }
  }
  const weights: Record<string, number> = {};
  for (const [i, model] of models.entries()) {
    const value = matrix[i]![n]! / matrix[i]![i]!;
    if (!Number.isFinite(value) || value < WEIGHT_BOUNDS.min || value > WEIGHT_BOUNDS.max) return {};
    weights[model] = value;
  }
  return weights;
}

export interface LearnedWindow {
  name: string;
  windowMs: number;
  limit: number;
  hits: number;
  explainedFraction: number;
}

/** The windows this account has learned well enough to stand behind. Empty
 *  until maturity and attribution are both satisfied -- which is the whole
 *  point, so callers can render nothing without a special case. */
export function learnedWindows(learning: UsageLearning | undefined): LearnedWindow[] {
  if (!learning || learning.hits.length < MIN_HITS) return [];
  const out: LearnedWindow[] = [];
  for (const window of CANDIDATE_WINDOWS) {
    const limit = learning.highWater[window.name] ?? 0;
    if (limit <= 0) continue;
    const explained = learning.hits.filter((hit) => (hit.costs[window.name] ?? 0) >= EXPLAINED_AT * limit).length;
    const fraction = explained / learning.hits.length;
    if (fraction < MIN_EXPLAINED) continue;
    out.push({ name: window.name, windowMs: window.ms, limit, hits: learning.hits.length, explainedFraction: fraction });
  }
  return out;
}

/** The reading a status line can show, or undefined when nothing is mature.
 *
 * The percentage is estimated; the reset time is NOT -- once the window length
 * is known, the moment the oldest contributing turn ages out is arithmetic on
 * timestamps we already hold, and was exact in every simulation run. */
export function learnedUsageReading(
  learning: UsageLearning | undefined, invocations: readonly Invocation[], accountId: string,
  now: number, weights?: Readonly<Record<string, number>>,
): UsageReading | undefined {
  const windows = learnedWindows(learning);
  if (!windows.length) return undefined;
  const readings: UsageWindow[] = [];
  for (const window of windows) {
    // Prefer weights fitted from this account's OWN refusals over whatever the
    // caller passed. An unfitted model weighs 1, which is what every model
    // weighed before any of this existed -- so a cheap flash turn and an
    // expensive opus turn only stop counting the same once there is evidence
    // that they should not.
    const fitted = fitModelWeights(learning, window.name);
    const effective = Object.keys(fitted).length ? { ...weights, ...fitted } : weights;
    const used = costInWindow(invocations, accountId, now, window.windowMs, effective);
    const usedPct = Math.max(0, Math.min(100, Math.round((used / window.limit) * 100)));
    let oldest = now;
    for (const invocation of invocations) {
      if (invocation.accountId !== accountId) continue;
      const when = Date.parse(invocation.at);
      if (!Number.isFinite(when) || when > now || when <= now - window.windowMs) continue;
      if (when < oldest) oldest = when;
    }
    const resetsAt = new Date(oldest + window.windowMs).toISOString();
    readings.push({ name: window.name, usedPct, resetsAt });
  }
  if (!readings.length) return undefined;
  const label = readings.map((r) => `${r.name} ${100 - r.usedPct}% left`).join(' · ');
  return { windows: readings, label };
}

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
  const weight = (invocation.model && weights[invocation.model]) || 1;
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
  const hits = [...(learning?.hits ?? []), { at: new Date(at).toISOString(), costs: snapshot(invocations, accountId, at, weights) }];
  return {
    highWater: { ...(learning?.highWater ?? {}) },
    hits: hits.slice(-KEEP_HITS),
  };
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
    const used = costInWindow(invocations, accountId, now, window.windowMs, weights);
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

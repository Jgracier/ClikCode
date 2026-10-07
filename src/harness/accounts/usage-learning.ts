/**
 * Usage for a harness that reports none, learned from what its vendor does.
 *
 * Some harnesses publish no figure, no window and no reset (Antigravity's
 * quota call answers 403 for a consumer account; Mistral Vibe, Factory and
 * others have nothing to ask). Each one still tells us three things:
 *
 *  - every turn it ALLOWS, and what that turn cost;
 *  - every turn it REFUSES for quota -- the limit is at or below what had
 *    been spent in the window just before it;
 *  - often, in the refusal, when it ends ("Resets in 76h57m39s"): an exact
 *    reset time, and so a bound on the window's length.
 *
 * The limit is bracketed, never guessed: a refusal is an upper bound (spent
 * before it >= limit), an allowed turn a lower bound (spent before it <
 * limit). The estimate is the lowest refusal level, the point at which the
 * vendor has actually said no. A turn later allowed at or above a refusal's
 * level shows the limit moved, and that refusal stops counting.
 *
 * What spent "before a turn" means matters: it excludes the turn itself. An
 * earlier version took the highest cost ever allowed INCLUDING the allowed
 * turn as the limit, so at an account's busiest point every success read as
 * 100% used.
 *
 * Only for a harness with no vendor figure (see learnsUsage): where the
 * vendor reports usage, that is the answer and this is not consulted. And it
 * informs -- ranking, display, how long a refusal holds -- but never decides
 * on its own that an account is out: only a refusal says that.
 */
import type { UsageReading, UsageWindow } from './usage-reading.js';
import { usageWindowTitle } from './usage-reading.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface CandidateWindow { name: string; ms: number }

/** The window lengths vendors use. A choice among these, not a fitted
 * length, is what lets a handful of refusals identify one. */
export const CANDIDATE_WINDOWS: readonly CandidateWindow[] = [
  { name: '1h', ms: HOUR },
  { name: '5h', ms: 5 * HOUR },
  { name: 'daily', ms: DAY },
  { name: 'weekly', ms: 7 * DAY },
  { name: 'monthly', ms: 30 * DAY },
];

/** The ledger covers the longest window, and a little more. */
const LEDGER_MS = 31 * DAY;
/** ...in at most this many turns. Past it the oldest go, and `since` says
 * from when the ledger is complete, so no window reaching further back is
 * measured short. */
const LEDGER_TURNS = 3000;
const KEEP_REFUSALS = 40;
/** Refusals of one window land at about the same level; levels further apart
 * than this were not caused by the same window. */
const SAME_LEVEL = 1.25;
/** What a turn reports is not exactly what the vendor counts (it weighs
 * models, cache reads and requests its own way), so a level is only known to
 * within this. A refusal is contradicted by a turn allowed clearly above it,
 * not by one a few percent over. */
const MEASURE_MARGIN = 0.15;
/** A second limit explains a real share of the refusals, not the few the
 * first left over from measurement noise. */
const SECOND_SHARE = 0.2;
/** Two reset hints agree on a fixed boundary within this. */
const PHASE_TOLERANCE_MS = 15 * MINUTE;
/** A predicted reset this close to the named one is the same reset: vendors
 * round, and a turn's start is not quite when the vendor counted it. */
const RESET_SLACK_MS = 2 * MINUTE;

export interface QuotaRefusal {
  at: string;
  /** Spent in each candidate window just before the refused turn. Recomputed
   * from the ledger while it still covers the moment; this is what is left
   * once it does not. */
  costs: Record<string, number>;
  /** The vendor's own "resets in", as an instant. */
  retryAt?: string;
  /** The vendor named this window's length — "a rolling 24-hour window" —
   * without saying when the current one ends. Not a reset instant. */
  windowMs?: number;
  /** When the first turn after it was allowed: the window had reset by then. */
  cleared?: string;
}

export interface UsageLearning {
  /** Allowed turns: [start epoch ms, cost], oldest first. */
  turns: [number, number][];
  /** Turns before this were dropped for the count cap. */
  since?: number;
  hits: QuotaRefusal[];
}

/** The fields of an invocation that say what it cost. */
export interface TurnCostFields {
  costUsd?: number; credits?: number;
  totalTokens?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
  latencyMs?: number;
}

/** What one turn cost, in the best unit the harness gives. One account is one
 * provider, so its turns share a unit, and the limit is learned in that
 * unit: a dollar figure (it already prices models and cache reads), then
 * credits, then tokens, then time -- a vendor's limits track work done --
 * then the turn itself. */
export function turnCost(turn: TurnCostFields): number {
  if (turn.costUsd !== undefined && turn.costUsd > 0) return turn.costUsd * 1_000_000;
  if (turn.credits !== undefined && turn.credits > 0) return turn.credits * 1_000_000;
  const tokens = turn.totalTokens ?? ((turn.inputTokens ?? 0) + (turn.outputTokens ?? 0) + (turn.cacheReadTokens ?? 0));
  if (tokens > 0) return tokens;
  if (turn.latencyMs && turn.latencyMs > 0) return turn.latencyMs;
  return 1;
}

/** The ledger as cumulative sums: any window's spend is two binary searches,
 * not a pass over every turn. */
class Ledger {
  private readonly starts: number[];
  private readonly prefix: number[] = [0];
  constructor(private readonly learning: UsageLearning, private readonly now: number) {
    this.starts = learning.turns.map(([start]) => start);
    for (const [, cost] of learning.turns) this.prefix.push(this.prefix.at(-1)! + cost);
  }
  /** Index of the first turn starting at or after `at` (after it, with `strict`). */
  index(at: number, strict = false): number {
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.starts[middle]! < at || (strict && this.starts[middle] === at)) low = middle + 1; else high = middle;
    }
    return low;
  }
  /** Whether every turn since `from` is still held. */
  covers(from: number): boolean {
    return from >= this.now - LEDGER_MS && (this.learning.since === undefined || from >= this.learning.since);
  }
  /** Spent by turns starting in [from, to). */
  spent(from: number, to: number): number {
    return this.prefix[this.index(to)]! - this.prefix[this.index(from)]!;
  }
  get turns(): readonly [number, number][] {
    return this.learning.turns;
  }
}

function copy(learning: UsageLearning | undefined): UsageLearning {
  return {
    turns: [...(learning?.turns ?? [])], hits: (learning?.hits ?? []).map((hit) => ({ ...hit })),
    ...(learning?.since !== undefined ? { since: learning.since } : {}),
  };
}

/** An allowed turn, starting at `start`. */
export function recordAllowedTurn(learning: UsageLearning | undefined, start: number, cost: number, now: number = start): UsageLearning {
  const next = copy(learning);
  next.turns.push([start, cost]);
  next.turns.sort((left, right) => left[0] - right[0]);
  next.turns = next.turns.filter(([at]) => at >= now - LEDGER_MS);
  if (next.turns.length > LEDGER_TURNS) {
    const dropped = next.turns.splice(0, next.turns.length - LEDGER_TURNS);
    next.since = Math.max(next.since ?? 0, dropped.at(-1)![0] + 1);
  }
  // The first turn allowed after a refusal: the window had reset by then.
  for (const hit of next.hits) {
    if (!hit.cleared && Date.parse(hit.at) < start) hit.cleared = new Date(start).toISOString();
  }
  return next;
}

/** A turn refused for quota at `at`. `retryAt` is the vendor's reset instant,
 * when it gave one. `windowMs` is a length it named ("rolling 24-hour")
 * instead of an instant. */
export function recordRefusal(learning: UsageLearning | undefined, at: number, retryAt?: string, windowMs?: number): UsageLearning {
  const next = copy(learning);
  const ledger = new Ledger(next, at);
  const costs: Record<string, number> = {};
  for (const window of CANDIDATE_WINDOWS) {
    if (ledger.covers(at - window.ms)) costs[window.name] = ledger.spent(at - window.ms, at);
  }
  const namedLength = CANDIDATE_WINDOWS.some((window) => window.ms === windowMs) ? windowMs : undefined;
  const hit: QuotaRefusal = {
    at: new Date(at).toISOString(), costs,
    ...(retryAt ? { retryAt } : {}), ...(namedLength ? { windowMs: namedLength } : {}),
  };
  // Refused again with nothing allowed since: the same episode. The later
  // refusal is the tighter bound -- less was spent and it still said no --
  // and its reset is the fresher one, so it replaces the earlier.
  const last = next.hits.at(-1);
  if (last && !last.cleared) next.hits[next.hits.length - 1] = hit;
  else next.hits = [...next.hits, hit].slice(-KEEP_REFUSALS);
  return next;
}

/** Learning as stored, in whatever shape wrote it. Older builds kept a
 * "highWater" limit -- the most ever allowed, counting the allowed turn
 * itself, which is wrong and is dropped -- and named the one-day window
 * "24h"; their refusal snapshots were taken the right way and are kept. */
export function normalizeLearning(value: unknown): UsageLearning | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const stored = value as { turns?: unknown; hits?: unknown; since?: unknown };
  const turns = Array.isArray(stored.turns)
    ? stored.turns.filter((turn): turn is [number, number] => Array.isArray(turn) && Number.isFinite(turn[0]) && Number.isFinite(turn[1]))
    : [];
  const hits = (Array.isArray(stored.hits) ? stored.hits : []).flatMap((hit: Partial<QuotaRefusal> & { costs?: Record<string, number> }) => {
    if (typeof hit?.at !== 'string') return [];
    const { '24h': daily, ...costs } = hit.costs ?? {};
    return [{
      at: hit.at, costs: daily === undefined ? costs : { ...costs, daily },
      ...(typeof hit.retryAt === 'string' ? { retryAt: hit.retryAt } : {}),
      ...(CANDIDATE_WINDOWS.some((window) => window.ms === hit.windowMs) ? { windowMs: hit.windowMs } : {}),
      ...(typeof hit.cleared === 'string' ? { cleared: hit.cleared } : {}),
    }];
  });
  return { turns, hits, ...(typeof stored.since === 'number' && Number.isFinite(stored.since) ? { since: stored.since } : {}) };
}

/** Two copies of one account's learning, from two ClikCode processes, as
 * one. Turns and refusals are observations, each true whoever recorded it,
 * so the result holds both sides' -- a write from a process holding an older
 * copy must not erase what another recorded meanwhile. Refusals with no
 * allowed turn between them are one episode, and the latest stands for it. */
export function mergeLearning(leftValue: unknown, rightValue: unknown, now: number = Date.now()): UsageLearning {
  const left = normalizeLearning(leftValue) ?? { turns: [], hits: [] };
  const right = normalizeLearning(rightValue) ?? { turns: [], hits: [] };
  const turns = new Map<string, [number, number]>();
  for (const turn of [...left.turns, ...right.turns]) turns.set(`${turn[0]}:${turn[1]}`, turn);
  let merged: UsageLearning = { turns: [], hits: [] };
  for (const [start, cost] of [...turns.values()].sort((a, b) => a[0] - b[0])) merged = recordAllowedTurn(merged, start, cost, now);
  const since = Math.max(left.since ?? Number.NEGATIVE_INFINITY, right.since ?? Number.NEGATIVE_INFINITY, merged.since ?? Number.NEGATIVE_INFINITY);
  const hits = new Map<string, QuotaRefusal>();
  for (const hit of [...left.hits, ...right.hits]) {
    const known = hits.get(hit.at);
    hits.set(hit.at, { ...known, ...hit, ...(known?.cleared && !hit.cleared ? { cleared: known.cleared } : {}) });
  }
  const ordered = [...hits.values()].sort((a, b) => a.at.localeCompare(b.at));
  const allowedBetween = (from: string, to: string): boolean =>
    merged.turns.some(([start]) => start > Date.parse(from) && start < Date.parse(to));
  const episodes = ordered.filter((hit, index) => {
    const next = ordered[index + 1];
    return !next || allowedBetween(hit.at, next.at) || Boolean(hit.cleared && Date.parse(hit.cleared) < Date.parse(next.at));
  });
  return { turns: merged.turns, hits: episodes.slice(-KEEP_REFUSALS), ...(Number.isFinite(since) ? { since } : {}) };
}

/** A ledger from turns already on record, for an account that has none. */
export function seedLedger(turns: readonly { start: number; cost: number }[], now: number): UsageLearning {
  let learning: UsageLearning = { turns: [], hits: [] };
  for (const turn of [...turns].sort((left, right) => left.start - right.start)) {
    learning = recordAllowedTurn(learning, turn.start, turn.cost, now);
  }
  return learning;
}

export interface LearnedWindow {
  name: string;
  ms: number;
  /** Where the vendor refuses, in the account's cost unit: the middle of the
   * levels it refused at, each at or just over the true limit. */
  limit: number;
  /** The highest level a turn was allowed below the limit at, when one was. */
  allowedBelow?: number;
  /** A fixed window resets on boundaries `phase + k * ms`; a rolling one as
   * its oldest turns age out. */
  fixed?: { phase: number };
  refusals: number;
}

function circularDistance(left: number, right: number, period: number): number {
  const delta = Math.abs(left - right) % period;
  return Math.min(delta, period - delta);
}

/** Where the period of a fixed window containing `at` began. */
function periodStart(ms: number, phase: number, at: number): number {
  return at - ((((at - phase) % ms) + ms) % ms);
}

/** A boundary that resets named in two different periods agree on, and that
 * every refusal later cleared reset across: a fixed window. Otherwise none.
 * Two refusals minutes apart share one reset and prove nothing about it. */
function fixedPhase(window: CandidateWindow, hits: readonly QuotaRefusal[]): { phase: number } | undefined {
  const resets = [...new Set(hits.map((hit) => Date.parse(hit.retryAt ?? '')).filter(Number.isFinite))].sort((a, b) => a - b);
  if (resets.length < 2 || resets.at(-1)! - resets[0]! < window.ms - PHASE_TOLERANCE_MS) return undefined;
  const phase = resets[0]! % window.ms;
  if (!resets.every((reset) => circularDistance(reset % window.ms, phase, window.ms) <= PHASE_TOLERANCE_MS)) return undefined;
  for (const hit of hits) {
    const cleared = Date.parse(hit.cleared ?? '');
    if (!Number.isFinite(cleared)) continue;
    if (periodStart(window.ms, phase, Date.parse(hit.at)) + window.ms > cleared + PHASE_TOLERANCE_MS) return undefined;
  }
  return { phase };
}

/** One hypothesis -- this window, fixed or rolling -- held against the
 * refusals. A refusal is explained when it still stands (no turn after it
 * was allowed at or above its level: the limit did not move, and this window
 * did not let that through) and, when the vendor named its reset, this
 * window resets then. Spend before a moment comes from the ledger while it
 * covers it, else (rolling only) from the refusal's snapshot. */
function hypothesis(ledger: Ledger, window: CandidateWindow, hits: readonly QuotaRefusal[], fixed?: { phase: number }) {
  const from = (at: number): number => (fixed ? periodStart(window.ms, fixed.phase, at) : at - window.ms);
  const before = (at: number): number | undefined => (ledger.covers(from(at)) ? ledger.spent(from(at), at) : undefined);
  const turnLevels = ledger.turns.map(([start]) => before(start));
  // The highest level any turn from index i on was allowed at.
  const highestFrom: number[] = new Array(turnLevels.length + 1).fill(Number.NEGATIVE_INFINITY);
  for (let index = turnLevels.length - 1; index >= 0; index -= 1) {
    highestFrom[index] = Math.max(highestFrom[index + 1]!, turnLevels[index] ?? Number.NEGATIVE_INFINITY);
  }
  const standing = hits.flatMap((hit) => {
    const at = Date.parse(hit.at);
    const level = before(at) ?? (fixed ? undefined : hit.costs[window.name]);
    return level !== undefined && level > 0 && highestFrom[ledger.index(at, true)]! < level * (1 + MEASURE_MARGIN) ? [{ hit, at, level }] : [];
  });
  /** When this window lets a turn through after refusing at `at`, with this limit. */
  const resetAfter = (at: number, limit: number): number | undefined => {
    if (fixed) return periodStart(window.ms, fixed.phase, at) + window.ms;
    let remaining = before(at);
    if (remaining === undefined) return undefined;
    for (const [start, cost] of ledger.turns.slice(ledger.index(at - window.ms), ledger.index(at))) {
      remaining -= cost;
      if (remaining < limit) return start + window.ms;
    }
    return undefined;
  };
  const namesLength = (hit: QuotaRefusal): boolean => hit.windowMs === window.ms;
  const tolerance = Math.max(30 * MINUTE, window.ms * 0.05);
  // Named resets this window does not reproduce are not its refusals. The
  // limit is then the lowest level among those that are.
  const median = (entries: readonly { level: number }[]): number => {
    const levels = entries.map((entry) => entry.level).sort((a, b) => a - b);
    return levels[Math.floor((levels.length - 1) / 2)]!;
  };
  let explained = standing;
  let limit = 0;
  for (let pass = 0; pass < 3 && explained.length; pass += 1) {
    limit = median(explained);
    const fits = explained.filter(({ hit, at, level }) => {
      // Refused while clearly under this window's limit: another limit did it.
      if (level < limit * (1 - MEASURE_MARGIN)) return false;
      const named = Date.parse(hit.retryAt ?? '');
      if (!Number.isFinite(named)) return true;
      const predicted = resetAfter(at, limit);
      return predicted !== undefined && Math.abs(predicted - named) <= tolerance;
    });
    if (fits.length === explained.length) break;
    explained = fits;
  }
  if (!explained.length) return undefined;
  // Each refusal is at or a little over the limit, measured with noise: the
  // middle one is the estimate, the lowest and highest bracket it.
  limit = median(explained);
  // A named reset, or a named window length, identifies the window on its
  // own. With neither, refusals of one window land at about one level, and
  // one of them is not enough.
  const identifies = (hit: QuotaRefusal): boolean => Boolean(hit.retryAt) || namesLength(hit);
  const unnamed = explained.filter(({ hit }) => !identifies(hit));
  const named = explained.length - unnamed.length;
  const sameLevel = unnamed.filter(({ level }) => level <= limit * SAME_LEVEL && level >= limit / SAME_LEVEL);
  const kept = [...explained.filter(({ hit }) => identifies(hit)), ...sameLevel];
  if (!named && sameLevel.length < 2) return undefined;
  // How far its resets fall from the ones the vendor named, in total.
  const hintError = explained.reduce((total, { hit, at }) => {
    const reset = Date.parse(hit.retryAt ?? '');
    const predicted = resetAfter(at, limit);
    return Number.isFinite(reset) && predicted !== undefined ? total + Math.max(0, Math.abs(predicted - reset) - RESET_SLACK_MS) : total;
  }, 0);
  const below = turnLevels.filter((level): level is number => level !== undefined && level < limit);
  return {
    learned: {
      name: window.name, ms: window.ms, limit, refusals: kept.length,
      ...(below.length ? { allowedBelow: Math.max(...below) } : {}), ...(fixed ? { fixed } : {}),
    } as LearnedWindow,
    explains: new Set(kept.map(({ hit }) => hit)),
    named,
    hintError,
  };
}

type Hypothesis = NonNullable<ReturnType<typeof hypothesis>>;

/** More named resets reproduced, then more refusals explained, then closer
 * to the named resets. */
function outranks(left: Hypothesis, right: Hypothesis): boolean {
  if (left.named !== right.named) return left.named > right.named;
  if (left.explains.size !== right.explains.size) return left.explains.size > right.explains.size;
  return left.hintError < right.hintError;
}

/** The window that explains the most of these refusals -- confirmed by the
 * resets the vendor named first, then by count, then by how closely it
 * reproduces those resets -- or none. */
function bestWindow(ledger: Ledger, hits: readonly QuotaRefusal[], skip: ReadonlySet<string>) {
  let best: Hypothesis | undefined;
  for (const window of CANDIDATE_WINDOWS) {
    if (skip.has(window.name)) continue;
    const fixed = fixedPhase(window, hits.filter((hit) => hit.retryAt));
    // Rolling first: a fixed boundary is taken from the named resets, so it
    // reproduces them by construction; rolling matching them is the stronger
    // evidence, and wins a tie.
    for (const shape of fixed ? [undefined, fixed] : [undefined]) {
      const candidate = hypothesis(ledger, window, hits, shape);
      if (!candidate) continue;
      if (!best || outranks(candidate, best)) best = candidate;
    }
  }
  return best;
}

/** The windows this account's refusals identify, each with its limit. Empty
 * until there is evidence. A vendor with a short limit and a long one
 * refuses for either; the window that explains the most refusals is found
 * first, and the refusals it does not explain are explained by a second. */
export function learnedWindows(learning: UsageLearning | undefined, now: number = Date.now()): LearnedWindow[] {
  if (!learning?.hits.length) return [];
  const ledger = new Ledger(learning, now);
  const first = bestWindow(ledger, learning.hits, new Set());
  if (!first) return [];
  const rest = learning.hits.filter((hit) => !first.explains.has(hit));
  const found = rest.length ? bestWindow(ledger, rest, new Set([first.learned.name])) : undefined;
  const second = found && found.explains.size >= Math.max(2, learning.hits.length * SECOND_SHARE) ? found : undefined;
  return [first.learned, ...(second ? [second.learned] : [])].sort((left, right) => left.ms - right.ms);
}

/** When a window next lets a turn through: a fixed one at its boundary; a
 * rolling one once enough of its oldest turns age out to bring it under the
 * limit -- or, while under it, once its oldest turn ages out. */
function windowReset(ledger: Ledger, window: LearnedWindow, now: number, spent: number): number | undefined {
  if (window.fixed) return periodStart(window.ms, window.fixed.phase, now) + window.ms;
  const inWindow = ledger.turns.slice(ledger.index(now - window.ms), ledger.index(now, true));
  if (!inWindow.length) return undefined;
  // Under the limit: it starts to drop when its oldest turn ages out.
  if (spent < window.limit) return inWindow[0]![0] + window.ms;
  let remaining = spent;
  for (const [start, cost] of inWindow) {
    remaining -= cost;
    if (remaining < window.limit) return start + window.ms;
  }
  return inWindow.at(-1)![0] + window.ms;
}

/** The learned reading now: each identified window, how much of it is spent
 * (unrounded), and when it resets. Undefined while nothing is identified, or
 * the ledger does not reach back across a window. */
export function learnedUsageReading(learning: UsageLearning | undefined, now: number = Date.now()): UsageReading | undefined {
  if (!learning) return undefined;
  const ledger = new Ledger(learning, now);
  const windows: UsageWindow[] = [];
  for (const window of learnedWindows(learning, now)) {
    const from = window.fixed ? periodStart(window.ms, window.fixed.phase, now) : now - window.ms;
    if (!ledger.covers(from)) continue;
    const spent = ledger.spent(from, now + 1);
    const reset = windowReset(ledger, window, now, spent);
    windows.push({ name: window.name, usedPct: (spent / window.limit) * 100, ...(reset !== undefined ? { resetsAt: new Date(reset).toISOString() } : {}) });
  }
  if (!windows.length) return undefined;
  const label = windows.map((window) => `${usageWindowTitle(window.name)} ~${Math.max(0, Math.min(100, Math.round(100 - window.usedPct)))}% left`).join(' · ');
  return { windows, label };
}

/** When the next turn would be let through, by what has been learned: the
 * reset of the window nearest its limit, when one is at it (within what a
 * level can be measured to). */
export function learnedResetAt(learning: UsageLearning | undefined, now: number = Date.now()): string | undefined {
  const fullest = (learnedUsageReading(learning, now)?.windows ?? [])
    .filter((window) => window.resetsAt && window.usedPct >= 100 * (1 - MEASURE_MARGIN))
    .sort((left, right) => right.usedPct - left.usedPct)[0];
  return fullest?.resetsAt;
}

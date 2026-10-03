import { describe, expect, it } from 'vitest';
import { learnedResetAt, learnedUsageReading, learnedWindows, recordAllowedTurn, recordRefusal, type UsageLearning } from './usage-learning.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-09-01T00:00:00.000Z');

/** A vendor with one window: it refuses a turn when what was spent in the
 * window just before it has reached the limit. */
interface Vendor { windowMs: number; limit: number; fixed?: boolean; hints: boolean; noise?: number }

function spentBefore(vendor: Vendor, turns: readonly [number, number][], at: number): number {
  const from = vendor.fixed ? at - (at % vendor.windowMs) : at - vendor.windowMs;
  return turns.filter(([start]) => start >= from && start < at).reduce((sum, [, cost]) => sum + cost, 0);
}

/** When this vendor would next allow a turn, refused at `at`. */
function vendorReset(vendor: Vendor, turns: readonly [number, number][], at: number): number {
  if (vendor.fixed) return at - (at % vendor.windowMs) + vendor.windowMs;
  for (let t = at; ; t += MINUTE) if (spentBefore(vendor, turns, t) < vendor.limit) return t;
}

/** Drive the learner through `count` turn attempts, one every `gapMs`, each
 * costing between 1 and 2 units of 100. */
function simulate(vendor: Vendor, count: number, gapMs: number, seed = 7) {
  let random = seed;
  const next = (): number => { random = (random * 48271) % 2147483647; return random / 2147483647; };
  let learning: UsageLearning | undefined;
  const turns: [number, number][] = [];
  const refusals: { at: number; reset: number }[] = [];
  const ours: [number, number][] = [];
  let at = T0;
  for (let index = 0; index < count; index += 1) {
    at += gapMs;
    const cost = Math.round(100 + next() * 100);
    // What the vendor counts can differ from what the turn reports.
    const counted = cost * (1 + (vendor.noise ?? 0) * (next() * 2 - 1));
    if (spentBefore(vendor, turns, at) >= vendor.limit) {
      const reset = vendorReset(vendor, turns, at);
      refusals.push({ at, reset });
      learning = recordRefusal(learning, at, vendor.hints ? new Date(reset).toISOString() : undefined);
    } else {
      turns.push([at, counted]);
      ours.push([at, cost]);
      learning = recordAllowedTurn(learning, at, cost, at);
    }
  }
  return { learning: learning!, turns, refusals, at };
}

describe('learning a limit the vendor never states', () => {
  it('places a rolling 5h limit between what it allowed and what it refused, from the vendor reset hints', () => {
    const vendor: Vendor = { windowMs: 5 * HOUR, limit: 3000, hints: true };
    const { learning, refusals, at } = simulate(vendor, 400, 10 * MINUTE);
    expect(refusals.length).toBeGreaterThan(2);
    const [window] = learnedWindows(learning, at);
    expect(window?.name).toBe('5h');
    expect(window?.fixed).toBeUndefined();
    // A refusal happens at or above the limit, at most one turn past it.
    expect(window!.limit).toBeGreaterThanOrEqual(vendor.limit);
    expect(window!.limit).toBeLessThan(vendor.limit + 200);
    expect(window!.allowedBelow!).toBeLessThan(vendor.limit);
  });

  it('identifies the window with no reset hints, from refusals landing at the same level', () => {
    const vendor: Vendor = { windowMs: 5 * HOUR, limit: 3000, hints: false };
    const { learning, at } = simulate(vendor, 400, 10 * MINUTE);
    const [window] = learnedWindows(learning, at);
    expect(window?.name).toBe('5h');
    expect(window!.limit).toBeGreaterThanOrEqual(vendor.limit);
    expect(window!.limit).toBeLessThan(vendor.limit + 200);
  });

  it('learns a fixed daily window and its boundary from two resets that agree', () => {
    const vendor: Vendor = { windowMs: DAY, limit: 6000, fixed: true, hints: true };
    const { learning, at } = simulate(vendor, 600, 20 * MINUTE);
    const [window] = learnedWindows(learning, at);
    expect(window?.name).toBe('daily');
    expect(window?.fixed?.phase).toBe(0);
    const reading = learnedUsageReading(learning, at);
    expect(Date.parse(reading!.windows[0]!.resetsAt!)).toBe(at - (at % DAY) + DAY);
  });

  it('does not read an allowed turn at a new peak as spent -- the bug that marked open accounts out', () => {
    const vendor: Vendor = { windowMs: 5 * HOUR, limit: 3000, hints: true };
    const { learning, at } = simulate(vendor, 400, 10 * MINUTE);
    // Every allowed turn left the window under the limit before it ran.
    for (const [start] of learning.turns) {
      const asOf = { turns: learning.turns.filter(([turn]) => turn < start), hits: learning.hits.filter((hit) => Date.parse(hit.at) < start) };
      const reading = learnedUsageReading(asOf, start);
      if (reading) expect(reading.windows[0]!.usedPct).toBeLessThan(100);
    }
    expect(at).toBeGreaterThan(T0);
  });

  it('predicts when a refused account can go again no later than the vendor lets it', () => {
    const vendor: Vendor = { windowMs: 5 * HOUR, limit: 3000, hints: false };
    const { learning, refusals, turns } = simulate(vendor, 400, 10 * MINUTE);
    const last = refusals.at(-1)!;
    const asOf = { turns: learning.turns.filter(([start]) => start < last.at), hits: learning.hits.filter((hit) => Date.parse(hit.at) <= last.at) };
    const predicted = Date.parse(learnedResetAt(asOf, last.at)!);
    expect(predicted).toBeLessThanOrEqual(last.reset);
    // Within one turn's gap of the truth.
    expect(last.reset - predicted).toBeLessThanOrEqual(10 * MINUTE + MINUTE);
    expect(turns.length).toBeGreaterThan(0);
  });

  it('drops a refusal once a later turn is allowed above its level: the limit was raised', () => {
    // Twenty turns of 100 from four hours back; a 5h window refuses at 2000
    // and frees up as the first of them ages out, an hour from now.
    let learning: UsageLearning | undefined;
    for (let index = 0; index < 20; index += 1) learning = recordAllowedTurn(learning, T0 - 4 * HOUR + index * MINUTE, 100, T0);
    learning = recordRefusal(learning, T0, new Date(T0 + HOUR).toISOString());
    learning = recordRefusal(learning, T0 + MINUTE, new Date(T0 + HOUR).toISOString());
    expect(learnedWindows(learning, T0 + MINUTE)[0]?.limit).toBe(2000);
    // Plan raised: a turn after both refusals is allowed with 2500 already spent.
    for (let index = 0; index < 5; index += 1) learning = recordAllowedTurn(learning, T0 + 2 * MINUTE + index, 100, T0 + 3 * MINUTE);
    learning = recordAllowedTurn(learning, T0 + 3 * MINUTE, 100, T0 + 3 * MINUTE);
    expect(learnedWindows(learning, T0 + 4 * MINUTE)).toEqual([]);
  });

  it('publishes nothing on one unhinted refusal: a single point is not a limit', () => {
    let learning: UsageLearning | undefined;
    for (let index = 0; index < 10; index += 1) learning = recordAllowedTurn(learning, T0 + index * MINUTE, 100);
    learning = recordRefusal(learning, T0 + 11 * MINUTE);
    expect(learnedWindows(learning, T0 + 12 * MINUTE)).toEqual([]);
    expect(learnedUsageReading(learning, T0 + 12 * MINUTE)).toBeUndefined();
  });

  it('stays honest across many histories when the vendor counts differently from what turns report', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      for (const hints of [true, false]) {
        const vendor: Vendor = { windowMs: 5 * HOUR, limit: 3000, hints, noise: 0.25 };
        const { learning, at } = simulate(vendor, 300, (5 + (seed % 10)) * MINUTE, seed * 7919);
        const windows = learnedWindows(learning, at);
        // It may decline to say -- never name the wrong window.
        for (const window of windows) expect(window.name, `seed ${seed} hints ${hints}`).toBe('5h');
        // Whatever it published, no allowed turn sits above it at the end.
        if (windows[0]) expect(windows[0].allowedBelow ?? 0).toBeLessThan(windows[0].limit);
      }
    }
  });

  it('separates a short limit from a long one by the resets the vendor names', () => {
    // 5h at 3000 and weekly at 12000, both rolling. Four-hour work sessions
    // each day fill the 5h window; by the third day the weekly cap refuses
    // at the start of a session, with the 5h window still empty.
    const short: Vendor = { windowMs: 5 * HOUR, limit: 3000, hints: true };
    const long: Vendor = { windowMs: 7 * DAY, limit: 12000, hints: true };
    let learning: UsageLearning | undefined;
    const turns: [number, number][] = [];
    let at = T0;
    for (let day = 0; day < 14; day += 1) {
      for (let step = 0; step < 30; step += 1) {
        at = T0 + day * DAY + 9 * HOUR + step * 8 * MINUTE;
        const longOut = spentBefore(long, turns, at) >= long.limit;
        const shortOut = spentBefore(short, turns, at) >= short.limit;
        if (longOut || shortOut) {
          const reset = Math.max(longOut ? vendorReset(long, turns, at) : 0, shortOut ? vendorReset(short, turns, at) : 0);
          learning = recordRefusal(learning, at, new Date(reset).toISOString());
        } else {
          turns.push([at, 150]);
          learning = recordAllowedTurn(learning, at, 150, at);
        }
      }
    }
    const windows = learnedWindows(learning, at);
    expect(windows.map((window) => window.name)).toEqual(['5h', 'weekly']);
    expect(windows[0]!.limit).toBeGreaterThanOrEqual(3000);
    expect(windows[0]!.limit).toBeLessThan(3150);
    expect(windows[1]!.limit).toBeGreaterThanOrEqual(12000);
    expect(windows[1]!.limit).toBeLessThan(12150);
  });
});

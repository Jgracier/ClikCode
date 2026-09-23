import { describe, expect, it } from 'vitest';
import { learnedUsageReading } from './usage-learning.js';
import type { HarnessState } from '../../session/model.js';

type Invocation = HarnessState['invocations'][number];
const HOUR = 3_600_000;
const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const turn = (minAgo: number, tokens: number): Invocation => ({
  id: `i${minAgo}`, accountId: 'acct', provider: 'antigravity', model: 'gemini-3.8-flash-high',
  at: new Date(T0 - minAgo * 60_000).toISOString(), latencyMs: 1000, totalTokens: tokens,
});

/**
 * What the status line gets. This is the seam the TUI reads through, so these
 * assert the exact contract: a label in the same shape Claude and Codex
 * publish, window structures carrying resetsAt, and -- most importantly --
 * undefined whenever the account has not earned a figure.
 */
describe('the learned reading a status line receives', () => {
  const invocations = [turn(30, 400_000), turn(120, 300_000)];

  it('says nothing at all on an account that has never hit a limit', () => {
    const fresh = { highWater: { '5h': 900_000 }, hits: [] };
    expect(learnedUsageReading(fresh, invocations, 'acct', T0)).toBeUndefined();
  });

  it('says nothing after a single limit hit', () => {
    const one = {
      highWater: { '5h': 900_000 },
      hits: [{ at: new Date(T0 - 60_000).toISOString(), costs: { '5h': 900_000 } }],
    };
    expect(learnedUsageReading(one, invocations, 'acct', T0)).toBeUndefined();
  });

  it('publishes a Claude-shaped label once mature', () => {
    const mature = {
      highWater: { '5h': 1_000_000 },
      hits: [
        { at: new Date(T0 - 2 * HOUR).toISOString(), costs: { '5h': 1_000_000 } },
        { at: new Date(T0 - HOUR).toISOString(), costs: { '5h': 980_000 } },
      ],
    };
    const reading = learnedUsageReading(mature, invocations, 'acct', T0);
    // 700k used of a learned 1M ceiling.
    expect(reading?.label).toBe('5h 30% left');
    expect(reading?.windows).toEqual([
      { name: '5h', usedPct: 70, resetsAt: new Date(T0 - 120 * 60_000 + 5 * HOUR).toISOString() },
    ]);
  });

  it('reports both windows when both have been hit', () => {
    const mature = {
      highWater: { '5h': 1_000_000, weekly: 2_000_000 },
      hits: [
        { at: new Date(T0 - 2 * HOUR).toISOString(), costs: { '5h': 1_000_000, weekly: 2_000_000 } },
        { at: new Date(T0 - HOUR).toISOString(), costs: { '5h': 990_000, weekly: 1_950_000 } },
      ],
    };
    const reading = learnedUsageReading(mature, invocations, 'acct', T0);
    expect(reading?.label).toBe('5h 30% left · weekly 65% left');
  });

  it('carries a resetsAt on every window, so the reading can expire itself', () => {
    // account-usage.ts reuses a reading only until its soonest window resets.
    // A window with no resetsAt would never expire and could sit stale.
    const mature = {
      highWater: { '5h': 1_000_000 },
      hits: [
        { at: new Date(T0 - 2 * HOUR).toISOString(), costs: { '5h': 1_000_000 } },
        { at: new Date(T0 - HOUR).toISOString(), costs: { '5h': 980_000 } },
      ],
    };
    const reading = learnedUsageReading(mature, invocations, 'acct', T0);
    expect(reading?.windows.every((w) => typeof w.resetsAt === 'string')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { HarnessState } from './model.js';
import { periodKey, tuneSaving, usageByPeriod } from './usage-periods.js';

const at = (iso: string): string => new Date(iso).toISOString();

describe('usage by period', () => {
  it('keys periods in local time, weeks from their Monday', () => {
    const when = new Date(2026, 10, 26, 14, 30); // Thursday
    expect(periodKey(when, 'hour')).toBe('2026-11-26 14:00');
    expect(periodKey(when, 'day')).toBe('2026-11-26');
    expect(periodKey(when, 'week')).toBe('week of 2026-11-23');
    expect(periodKey(when, 'month')).toBe('2026-11');
    expect(periodKey(when, 'year')).toBe('2026');
  });

  it('sums each account per period and the measured comparison', () => {
    const invocations: HarnessState['invocations'] = [
      { id: 'a', accountId: 'one', provider: 'anthropic', sessionId: 's', at: at('2026-11-24T10:00:00'), inputTokens: 1000, outputTokens: 0, latencyMs: 1, contextCalls: 1, contextSum: 1000, shadowSum: 3000 },
      { id: 'b', accountId: 'one', provider: 'anthropic', sessionId: 's', at: at('2026-11-24T11:00:00'), inputTokens: 500, outputTokens: 0, latencyMs: 1 },
      { id: 'c', accountId: 'two', provider: 'openai', sessionId: 't', at: at('2026-11-23T11:00:00'), inputTokens: 200, outputTokens: 0, latencyMs: 1 },
    ];
    const rows = usageByPeriod({ invocations }, 'day');
    expect(rows.map((row) => [row.period, row.accountId, row.turns, row.tokens])).toEqual([
      ['2026-11-24', 'one', 2, 1500], ['2026-11-23', 'two', 1, 200],
    ]);
    expect(rows[0]).toMatchObject({ measuredTurns: 1, measuredTokens: 1000, withoutTuneTokens: 3000 });
    expect(usageByPeriod({ invocations }, 'day', { accountId: 'two' })).toHaveLength(1);
    expect(usageByPeriod({ invocations }, 'hour')).toHaveLength(3);
    const saving = tuneSaving(rows);
    expect(saving).toMatchObject({ measuredTokens: 1000, withoutTuneTokens: 3000, savedTokens: 2000 });
    expect(saving.savedShare).toBeCloseTo(2 / 3);
    expect(saving.coverage).toBeCloseTo(1000 / 1700);
  });
});

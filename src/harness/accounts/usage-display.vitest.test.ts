import { describe, expect, it } from 'vitest';
import { accountDisplayUsage, markQuotaExhausted, usageReading, usageResetLabel } from './usage-reading.js';
import type { AiHarnessAccount } from '../definition.js';

const now = Date.parse('2026-10-26T01:00:00Z');
const reset = '2026-10-28T07:00:00Z';
const account = (): AiHarnessAccount => ({ id: 'a', provider: 'anthropic', label: 'test', authKind: 'vendor-cli', models: [], status: 'ready' });

describe('usage display at the limit', () => {
  it.each([99.6, 100, 101])('shows 1%% until refusal without changing the vendor reading (%s)', (usedPct) => {
    const raw = usageReading([{ name: 'weekly', usedPct, resetsAt: reset }])!;
    const shown = accountDisplayUsage(account(), raw, now)!;
    expect(shown.label).toBe('Weekly 1% left');
    expect(usageResetLabel(shown.windows, now)).toBeUndefined();
    expect(raw.windows[0]!.usedPct).toBe(usedPct);
  });
  it('shows zero and the reset after a refusal, then releases the display floor when the hold expires', () => {
    const a = account();
    const raw = usageReading([{ name: 'weekly', usedPct: 100, resetsAt: reset }])!;
    markQuotaExhausted(a, now, reset);
    const shown = accountDisplayUsage(a, raw, now)!;
    expect(shown.label).toBe('Weekly 0% left');
    expect(usageResetLabel(shown.windows, now)).toContain('Resets');
    expect(accountDisplayUsage(a, raw, Date.parse(reset) + 1)?.label).toBe('Weekly 1% left');
  });
  it('preserves advisory pools and balance labels', () => {
    const raw = usageReading([{ name: 'API', usedPct: 100, advisory: true }])!;
    expect(accountDisplayUsage(account(), raw, now)?.label).toBe('API 0% left');
    expect(accountDisplayUsage(account(), { windows: [], label: '$3 left' }, now)?.label).toBe('$3 left');
  });
});

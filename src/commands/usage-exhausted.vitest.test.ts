/** One sentence for running out, whatever the harness called it. */
import { describe, expect, it } from 'vitest';
import { usageExhaustedMessage, quotaResetPhrase, nextQuotaReset } from './usage-exhausted';
import type { AiHarnessAccount } from './types.js';

const NOW = Date.parse('2026-09-21T14:00:00');
const account = (windows: Array<{ name: string; usedPct: number; resetsAt?: string }>): AiHarnessAccount =>
  ({ id: 'a', provider: 'p', label: 'me', usage: { at: '', windows } } as unknown as AiHarnessAccount);

describe('being out of quota', () => {
  it('gives the time when the window comes back today', () => {
    const message = usageExhaustedMessage(
      [account([{ name: '5h', usedPct: 100, resetsAt: new Date(Date.parse('2026-09-21T16:50:00')).toISOString() }])], NOW);
    expect(message).toBe('usage exhausted · resets at 4:50PM');
  });

  it('gives the date as well when it does not', () => {
    // A weekly window on a Monday that returns on Saturday: the time alone
    // would read as "tonight".
    const message = usageExhaustedMessage(
      [account([{ name: 'weekly', usedPct: 100, resetsAt: new Date(Date.parse('2026-09-26T19:00:00')).toISOString() }])], NOW);
    expect(message).toBe('usage exhausted · resets Sat 26 Sep at 7:00PM');
  });

  it('asks for credits when nothing on offer ever comes back', () => {
    // A spent balance, or a vendor that reports no window at all -- which is
    // exactly what Grok Build's 402 is.
    expect(usageExhaustedMessage([account([])], NOW)).toBe('usage exhausted · add credits');
    expect(usageExhaustedMessage([], NOW)).toBe('usage exhausted · add credits');
  });

  it('takes the soonest reset across every account that was tried', () => {
    const message = usageExhaustedMessage([
      account([{ name: 'weekly', usedPct: 100, resetsAt: new Date(Date.parse('2026-09-26T19:00:00')).toISOString() }]),
      account([{ name: '5h', usedPct: 100, resetsAt: new Date(Date.parse('2026-09-21T15:30:00')).toISOString() }]),
    ], NOW);
    expect(message).toBe('usage exhausted · resets at 3:30PM');
  });

  it('ignores a window that still has room, and one already past', () => {
    expect(nextQuotaReset([account([
      { name: '5h', usedPct: 40, resetsAt: new Date(Date.parse('2026-09-21T15:00:00')).toISOString() },
      { name: 'weekly', usedPct: 100, resetsAt: new Date(Date.parse('2026-09-20T10:00:00')).toISOString() },
    ])], NOW)).toBeUndefined();
  });

  it('formats a same-day reset without a date', () => {
    expect(quotaResetPhrase(new Date(Date.parse('2026-09-21T09:05:00')), NOW)).toBe('at 9:05AM');
  });
});

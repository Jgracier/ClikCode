/** One sentence for running out, whatever the harness called it. */
import { describe, expect, it } from 'vitest';
import { usageExhaustedMessage, quotaResetPhrase, nextQuotaReset, isUsageExhaustedMessage } from './usage-exhausted';
import type { AiHarnessAccount } from '../harness/definition.js';

const NOW = Date.parse('2026-09-21T14:00:00');
const account = (windows: Array<{ name: string; usedPct: number; resetsAt?: string }>): AiHarnessAccount =>
  ({ id: 'a', provider: 'p', label: 'me', usage: { at: '', windows } } as unknown as AiHarnessAccount);

describe('being out of quota', () => {
  it('says the same thing for every harness, with no reset and no error', () => {
    expect(usageExhaustedMessage(
      [account([{ name: '5h', usedPct: 100, resetsAt: new Date(Date.parse('2026-09-21T16:50:00')).toISOString() }])], NOW,
    )).toBe('All accounts exhausted');
    expect(usageExhaustedMessage([account([])], NOW)).toBe('All accounts exhausted');
    expect(usageExhaustedMessage([], NOW)).toBe('All accounts exhausted');
  });

  it('ignores a window that still has room, and one already past', () => {
    expect(nextQuotaReset([account([
      { name: '5h', usedPct: 40, resetsAt: new Date(Date.parse('2026-09-21T15:00:00')).toISOString() },
      { name: 'weekly', usedPct: 100, resetsAt: new Date(Date.parse('2026-09-20T10:00:00')).toISOString() },
    ])], NOW)).toBeUndefined();
  });

  it('formats a same-day reset without a date', () => {
    expect(quotaResetPhrase(new Date(Date.parse('2026-09-21T09:05:00')), NOW)).toBe('9:05AM');
  });
});

describe('a vendor error that says it in its own words', () => {
  it('recognises Grok Build running out of balance', async () => {
    const { classifyAccountFailure } = await import('./failover');
    // The real shape: no status field anywhere, the code buried in the text.
    const failure = new Error('Grok Build: Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}');
    expect(classifyAccountFailure(failure, { isResultError: true })).toBe('quota-exhausted');
  });

  it('still recognises the wordings that carry no status at all', async () => {
    const { classifyAccountFailure } = await import('./failover');
    for (const text of ['insufficient balance', 'your credit is exhausted', 'weekly limit reached']) {
      expect(classifyAccountFailure(new Error(text), { isResultError: true }), text).toBe('quota-exhausted');
    }
  });

  it('does not mistake an ordinary failure for running out', async () => {
    const { classifyAccountFailure } = await import('./failover');
    expect(classifyAccountFailure(new Error('connection reset by peer'), { isResultError: true })).not.toBe('quota-exhausted');
    // 404 is embedded the same way a 402 is, and is not a quota problem.
    expect(classifyAccountFailure(new Error('API error (status 404 Not Found)'), { isResultError: true })).not.toBe('quota-exhausted');
  });
});

describe('isUsageExhaustedMessage', () => {
  it('recognises both forms ClikCode composes', () => {
    expect(isUsageExhaustedMessage('All accounts exhausted')).toBe(true);
    expect(isUsageExhaustedMessage('Credits Exhausted')).toBe(true);
    expect(isUsageExhaustedMessage('Usage Exhausted · Resets 5:34PM')).toBe(true);
  });

  it('does not claim a vendor error or a crash', () => {
    expect(isUsageExhaustedMessage('Grok Build returned no assistant text')).toBe(false);
    expect(isUsageExhaustedMessage('ENOENT: no such file or directory')).toBe(false);
  });

  it('matches whatever usageExhaustedMessage actually produces', () => {
    expect(isUsageExhaustedMessage(usageExhaustedMessage([]))).toBe(true);
  });
});

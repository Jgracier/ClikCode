import { describe, expect, it } from 'vitest';
import { ampUsageLabel, copilotQuotaReading, kiloProfileLabel, kimiQuotaReading, kimiWebEndpoint } from './cli-usage-probes.js';

const NOW = Date.parse('2026-09-30T04:42:49.300Z');

describe('Copilot account.getQuota', () => {
  // copilot 1.0.88, `copilot --headless --no-auto-update --stdio`, a free
  // account whose chat allowance is spent (its turns answer HTTP 402).
  const FREE_SPENT = {
    quotaSnapshots: {
      chat: { isUnlimitedEntitlement: false, entitlementRequests: 200, usedRequests: 200, usageAllowedWithExhaustedQuota: false, overage: 1, overageAllowedWithExhaustedQuota: false, remainingPercentage: 0, resetDate: '2026-09-30T04:42:49.268Z', hasQuota: false, tokenBasedBilling: true },
      completions: { isUnlimitedEntitlement: false, entitlementRequests: 2000, usedRequests: 0, usageAllowedWithExhaustedQuota: false, overage: 0, overageAllowedWithExhaustedQuota: false, remainingPercentage: 100, resetDate: '2026-09-30T04:42:49.268Z', hasQuota: true, tokenBasedBilling: true },
      premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 0, usedRequests: 0, usageAllowedWithExhaustedQuota: false, overage: 0, overageAllowedWithExhaustedQuota: false, remainingPercentage: 0, resetDate: '2026-09-30T04:42:49.268Z', hasQuota: false, tokenBasedBilling: true },
    },
  };

  it('reads the chat allowance, not completions or a zero entitlement, and drops a reset that is just the request time', () => {
    expect(copilotQuotaReading(FREE_SPENT, NOW)).toEqual({ windows: [{ name: 'chat', usedPct: 100 }], label: 'chat 0% left' });
  });

  it('reads a paid plan\'s premium requests with their reset', () => {
    const paid = { quotaSnapshots: { premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: 72, remainingPercentage: 76, resetDate: '2026-10-01T00:00:00.000Z' }, chat: { isUnlimitedEntitlement: true, entitlementRequests: 0 } } };
    expect(copilotQuotaReading(paid, NOW)).toEqual({ windows: [{ name: 'premium', usedPct: 24, resetsAt: '2026-10-01T00:00:00.000Z' }], label: 'premium 76% left' });
  });

  it('says nothing about a payload with no snapshots', () => {
    expect(copilotQuotaReading({}, NOW)).toBeUndefined();
  });
});

describe('Kimi /api/v1/oauth/usage', () => {
  it('finds the server and token in the startup banner', () => {
    const banner = '  \u001b[1mKimi server ready\u001b[0m  2.0.2\n\n  Local:    http://127.0.0.1:45349/#token=abcDEF123_-x\n  Network:  off\n\n  Token:    abcDEF123_-x\n';
    expect(kimiWebEndpoint(banner)).toEqual({ url: 'http://127.0.0.1:45349', token: 'abcDEF123_-x' });
  });

  it('reads kimi\'s own normalized windows', () => {
    const body = { code: 0, msg: 'success', data: { kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.25, resetAt: '2026-09-30T09:00:00Z' }, limit7d: { usedRatio: 0.1 } }, extraUsage: null } } };
    expect(kimiQuotaReading(body)).toEqual({
      windows: [{ name: '5h', usedPct: 25, resetsAt: '2026-09-30T09:00:00.000Z' }, { name: 'weekly', usedPct: 10 }], label: '5h 75% left · weekly 90% left',
    });
  });

  it('an account with no plan windows has no reading (the live answer for this machine\'s account)', () => {
    expect(kimiQuotaReading({ code: 0, msg: 'success', data: { kind: 'ok', quota: { usages: {}, extraUsage: null } }, request_id: 'r' })).toBeUndefined();
  });
});

describe('credit balances', () => {
  it('amp usage', () => {
    expect(ampUsageLabel('Signed in as someone@example.com\n**Individual credits:** $9.36 remaining (set up auto-reload to avoid running out) - https://ampcode.com/settings\n'))
      .toBe('$9.36 credits left');
  });

  it('kilo profile', () => {
    expect(kiloProfileLabel('Name: Someone\nEmail: someone@example.com\nTeam: Personal\nBalance: $0.00\n')).toBe('$0 credits left');
    expect(kiloProfileLabel('Balance: $1,204.50')).toBe('$1204.50 credits left');
  });
});

import { describe, expect, it } from 'vitest';
import { ampUsageLabel, auggieUsageLabel, clineQuotaReading, commandCodeQuotaReading, copilotQuotaReading, cursorQuotaReading, kiloProfileLabel, kimiQuotaReading, kimiWebEndpoint, kiroQuotaReading } from './cli-usage-probes.js';

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
    expect(copilotQuotaReading(FREE_SPENT, NOW)).toEqual({ windows: [{ name: 'chat', usedPct: 100 }], label: 'Chat 0% left' });
  });

  it('reads a paid plan\'s premium requests with their reset', () => {
    const paid = { quotaSnapshots: { premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: 72, remainingPercentage: 76, resetDate: '2026-10-01T00:00:00.000Z' }, chat: { isUnlimitedEntitlement: true, entitlementRequests: 0 } } };
    expect(copilotQuotaReading(paid, NOW)).toEqual({ windows: [{ name: 'premium', usedPct: 24, resetsAt: '2026-10-01T00:00:00.000Z' }], label: 'Premium 76% left' });
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
      windows: [{ name: '5h', usedPct: 25, resetsAt: '2026-09-30T09:00:00.000Z' }, { name: 'weekly', usedPct: 10 }], label: '5h 75% left · Weekly 90% left',
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

  it('auggie account status', () => {
    const status = (amountRemaining: unknown, usageUnit: unknown = 'usd') => JSON.stringify({
      planName: 'Free Plan', usageUnit, amountRemaining, amountIncludedPerCycle: '0', billingCycleEndDate: '2026-10-21T19:55:49Z',
    });
    expect(auggieUsageLabel(status('12.5'))).toBe('$12.50 credits left');
    expect(auggieUsageLabel(status('7'))).toBe('$7 credits left');
    expect(auggieUsageLabel(status('0'))).toBe('Out Of Credits');
    expect(auggieUsageLabel(status('40', 'credits'))).toBe('40 credits credits left');
    expect(auggieUsageLabel(status('n/a'))).toBeUndefined();
    expect(auggieUsageLabel('not json')).toBeUndefined();
  });
});

describe('Cursor plan usage', () => {
  // GetCurrentPeriodUsage on a Free account, 2026-09-30 (trimmed).
  const answer = {
    billingCycleStart: '1790013310084', billingCycleEnd: '1792605310084',
    planUsage: { totalSpend: 13, bonusSpend: 13, autoPercentUsed: 13, apiPercentUsed: 0, totalPercentUsed: 6.5 },
    displayMessage: "You've used 0% of your included usage",
  };
  it('reads the Auto and API shares as windows resetting at the cycle end', () => {
    const reading = cursorQuotaReading(answer);
    expect(reading?.label).toBe('Auto 87% left · API 100% left');
    expect(reading?.windows[0]).toEqual({ name: 'auto', usedPct: 13, resetsAt: new Date(1792605310084).toISOString() });
  });
  // GetCurrentPeriodUsage, 2026-10-06, an account whose turns answer "You've
  // hit your usage limit": the total is the shares' average, half full.
  it('a spent Auto share is a spent account, whatever the total says', () => {
    const spent = cursorQuotaReading({ billingCycleEnd: '1793508407644', planUsage: { autoPercentUsed: 100, apiPercentUsed: 0, totalPercentUsed: 50 } });
    expect(spent?.label).toBe('Auto 0% left · API 100% left');
  });
  // A Free account with no bonus: 0% used, yet its turns answer "Upgrade
  // your plan to continue" (2026-10-06).
  it('a Free plan with no bonus left is spent at 0%; a paid plan is not', () => {
    const none = { billingCycleEnd: '1793651420000', planUsage: { remainingBonus: false, autoPercentUsed: 0, apiPercentUsed: 0, totalPercentUsed: 0 } };
    expect(cursorQuotaReading(none, 'Free')?.label).toBe('Auto 0% left');
    expect(cursorQuotaReading(none, 'Pro')?.label).toBe('Auto 100% left · API 100% left');
    expect(cursorQuotaReading({ ...none, planUsage: { ...none.planUsage, remainingBonus: true } }, 'Free')?.label).toBe('Auto 100% left');
  });
  it('has nothing to say without plan usage', () => {
    expect(cursorQuotaReading({ displayMessage: 'x' })).toBeUndefined();
  });
});

describe('Cline credits balance', () => {
  // GET /api/v1/users/{id}/balance, 2026-10-06: turns on this account answered
  // "Insufficient balance. Your Cline Credits balance is $-0.20".
  // Its :free models still answered on all 12 such accounts: not spent.
  it('a balance at or below zero is out of credits, but the account still runs free models', () => {
    const spent = clineQuotaReading({ data: { userId: 'usr-1', balance: -195907 }, success: true });
    expect(spent).toEqual({ windows: [{ name: 'credits', usedPct: 100, advisory: true }], label: 'Out of credits · free models only' });
  });
  it('a positive balance is dollars left, and never spent', () => {
    expect(clineQuotaReading({ data: { balance: 450000 } })).toEqual({ windows: [], label: '$0.45 credits left' });
    expect(clineQuotaReading({ error: 'x' })).toBeUndefined();
  });
});

describe('Kiro /usage over ACP', () => {
  // `_kiro.dev/commands/execute` usage, kiro-cli 2.23.1, KIRO FREE.
  const data = {
    planName: 'KIRO FREE', billingCycleReset: '2026-11-01', overagesEnabled: false,
    usageBreakdowns: [{ resourceType: 'CREDIT', displayName: 'Credits', used: 0.14, limit: 50, percentage: 0.28, hasLimit: true }],
  };
  it('reads plan credits as a monthly window resetting with the billing cycle', () => {
    const reading = kiroQuotaReading(data);
    expect(reading?.label).toBe('Monthly 100% left');
    expect(reading?.windows[0]).toEqual({ name: 'monthly', usedPct: 0.28, resetsAt: '2026-11-01T00:00:00.000Z' });
  });
  it('has nothing to say without a credit limit', () => {
    expect(kiroQuotaReading({ usageBreakdowns: [] })).toBeUndefined();
  });
});

describe('Command Code /alpha/billing/credits', () => {
  it('reads the plan windows when it has them', () => {
    const reading = commandCodeQuotaReading({
      credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: { limited: true, fiveHour: { used: 30, cap: 120, resetAt: '2026-10-01T03:00:00Z' }, weekly: { used: 600, cap: 1000, resetAt: '2026-10-05T00:00:00Z' } },
    });
    expect(reading?.label).toBe('5h 75% left · Weekly 40% left');
  });
  it('falls back to the credit balance, and says nothing for an empty free account', () => {
    expect(commandCodeQuotaReading({ credits: { monthlyCredits: 10, purchasedCredits: 2.5, freeCredits: 0 }, windowLimits: { limited: false } })?.label).toBe('12.50 credits left');
    // The real answer for this machine's free account, 2026-09-30.
    expect(commandCodeQuotaReading({ credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 }, windowLimits: { limited: false, exceeded: null, fiveHour: null, weekly: null } })).toBeUndefined();
  });
});

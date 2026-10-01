/** Cursor runs out the way the ACP TypeScript SDK reports any agent error,
 * and its plan has a share that runs out without stopping the account. */
import { describe, expect, it } from 'vitest';
import { jsonRpcErrorDetail } from '../harness/transport/jsonrpc-peer.js';
import { classifyAccountFailure } from './failover.js';
import { accountQuotaSpent } from '../harness/accounts/usage-reading.js';
import { cursorQuotaReading } from '../harness/accounts/cli-usage-probes.js';
import type { AiHarnessAccount } from '../harness/definition.js';

describe('a refused Cursor turn', () => {
  // @agentclientprotocol/sdk: St.internalError({ details: error.message }).
  it('reads the reason the SDK puts in data.details', () => {
    expect(jsonRpcErrorDetail({ details: 'PRO_USER_USAGE_LIMIT: You have hit your plan limit' }).reason)
      .toBe('PRO_USER_USAGE_LIMIT: You have hit your plan limit');
  });

  it('is a spent plan for its usage-limit codes and throttling for its rate limits', () => {
    for (const code of ['FREE_USER_USAGE_LIMIT', 'PRO_USER_USAGE_LIMIT', 'USAGE_PRICING_REQUIRED']) {
      expect(classifyAccountFailure(new Error(`Internal error: ${code}`))).toBe('quota-exhausted');
    }
    for (const code of ['FREE_USER_RATE_LIMIT_EXCEEDED', 'PRO_USER_RATE_LIMIT_EXCEEDED', 'RATE_LIMITED']) {
      expect(classifyAccountFailure(new Error(`Internal error: ${code}`))).toBe('temporarily-throttled');
    }
    expect(classifyAccountFailure(new Error('Internal error'))).toBe('other');
  });
});

describe("Cursor's plan windows", () => {
  const account = (total: number, api: number) => ({
    id: 'a', provider: 'cursor', label: 'a@example.com', authKind: 'vendor-cli', models: [], status: 'ready',
    usage: { at: new Date().toISOString(), ...cursorQuotaReading({ billingCycleEnd: String(Date.now() + 86_400_000), planUsage: { totalPercentUsed: total, apiPercentUsed: api } }) },
  }) as unknown as AiHarnessAccount;

  it('keeps an account whose named-model share is spent: Auto still runs', () => {
    expect(accountQuotaSpent(account(40, 100))).toBe(false);
  });
  it('marks it spent once the plan total is', () => {
    expect(accountQuotaSpent(account(100, 100))).toBe(true);
  });
});

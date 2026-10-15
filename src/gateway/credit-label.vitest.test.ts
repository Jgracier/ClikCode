import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./credentials.js', () => ({ getApiUrl: () => 'https://clikdeploy.com', getApiKeyForUrl: () => 'cd_live_key' }));
const { gatewayCreditLabel, resetGatewayCreditLabel } = await import('./credit-label.js');

const credits = (data: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));

afterEach(() => resetGatewayCreditLabel());

describe('the Gateway credit on the composer rule', () => {
  it('says what is left, that it has run out, or that the account is not metered', async () => {
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ balanceUsd: 4.5 }) as never })).toBe('$4.50 credit left');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ balanceMicroUsd: 0 }) as never })).toBe('Out of credits');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ unlimited: true }) as never })).toBe('Unlimited credit');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({}) as never })).toBeUndefined();
  });

  it('asks the Gateway again only after a turn, or once its reading is a minute old', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { credit: { unlimited: false, allowed: true, balanceMicroUsd: '2000000' }, lifetimeChargeMicroUsd: 1_000_000 } }), { status: 200 }));
    await gatewayCreditLabel({} as never, { fetchImpl: fetchImpl as never });
    await gatewayCreditLabel({} as never, { fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('says what the account has used and what is available, from the usage ledger', async () => {
    const usage = (credit: Record<string, unknown>, chargeMicroUsd = 65_420_000) => vi.fn(async () => new Response(JSON.stringify({ data: { credit, totals: { chargeMicroUsd: 1 }, lifetimeChargeMicroUsd: chargeMicroUsd } }), { status: 200 }));
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: usage({ unlimited: false, allowed: true, balanceMicroUsd: '12450000' }) as never })).toBe('$65.42 used • $12.45 available');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: usage({ unlimited: false, allowed: false, balanceMicroUsd: '0' }) as never })).toBe('$65.42 used • Out of credits');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: usage({ unlimited: true }) as never })).toBe('$65.42 used • Unlimited');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./credentials.js', () => ({ getApiUrl: () => 'https://clikdeploy.com', getApiKeyForUrl: () => 'cd_live_key' }));
const { gatewayCreditLabel, resetGatewayCreditLabel } = await import('./credit-label.js');

const credits = (data: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));

afterEach(() => resetGatewayCreditLabel());

describe('the Gateway credit on the composer rule', () => {
  it('says what is left, or that it has run out, and nothing for an unlimited account', async () => {
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ balanceUsd: 4.5 }) as never })).toBe('$4.50 credit left');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ balanceMicroUsd: 0 }) as never })).toBe('Out of credits');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ unlimited: true }) as never })).toBeUndefined();
  });

  it('asks the Gateway again only after a turn, or once its reading is a minute old', async () => {
    const fetchImpl = credits({ balanceUsd: 2 });
    await gatewayCreditLabel({} as never, { fetchImpl: fetchImpl as never });
    await gatewayCreditLabel({} as never, { fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./credentials.js', () => ({ getApiUrl: () => 'https://clikdeploy.com', getApiKeyForUrl: () => 'cd_live_key' }));
const { gatewayCreditLabel, gatewayConversationUsageLabel, resetGatewayCreditLabel } = await import('./credit-label.js');

const credits = (data: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));

afterEach(() => resetGatewayCreditLabel());

describe('the Gateway credit on the composer rule', () => {
  it('says what is left, that it has run out, or that the account is not metered', async () => {
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ balanceUsd: 4.5 }) as never })).toBe('$4.50 credit left');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ balanceMicroUsd: 0 }) as never })).toBe('Out of credits');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ unlimited: true }) as never })).toBe('Unlimited credit');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({}) as never })).toBeUndefined();
  });

  it('combines this conversation\'s cost with the remaining account credit', () => {
    expect(gatewayConversationUsageLabel(0.023, '$12.45 credit left')).toBe('$0.02 this chat • $12.45 credit left');
    expect(gatewayConversationUsageLabel(undefined, '$12.45 credit left')).toBe('$12.45 credit left');
    expect(gatewayConversationUsageLabel(0.023, undefined)).toBe('$0.02 this chat');
    expect(gatewayConversationUsageLabel(undefined, undefined)).toBeUndefined();
  });

  it('asks the Gateway for the balance again only after a turn, or once its reading is a minute old', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { unlimited: false, allowed: true, balanceMicroUsd: '2000000' } }), { status: 200 }));
    await gatewayCreditLabel({} as never, { fetchImpl: fetchImpl as never });
    await gatewayCreditLabel({} as never, { fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shows remaining credits and never substitutes lifetime spend for this chat\'s cost', async () => {
    const credits = (data: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ balanceMicroUsd: '12450000', lifetimeCostMicroUsd: 65_420_000 }) as never })).toBe('$12.45 credit left');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ unlimited: false, allowed: false, balanceMicroUsd: '0' }) as never })).toBe('Out of credits');
    expect(await gatewayCreditLabel({} as never, { fresh: true, fetchImpl: credits({ unlimited: true, lifetimeCostMicroUsd: 65_420_000 }) as never })).toBe('Unlimited credit');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindGlobalFlags } from '../../cli/output-mode.js';

vi.mock('../../gateway/credentials.js', () => ({
  getApiUrl: () => 'https://clikdeploy.com',
  getApiKeyForUrl: () => 'cd_live_key',
}));

const { aiGatewayUsage, aiGatewayCredit } = await import('./status.js');

const config = {} as never;

afterEach(() => { vi.restoreAllMocks(); bindGlobalFlags({}); });

describe('gateway usage', () => {
  it('reads the signed-in account\'s usage and credit from the Gateway and reports them', async () => {
    bindGlobalFlags({ json: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchImpl = vi.fn(async (url: URL) => String(url).includes('/credits')
      ? new Response(JSON.stringify({ data: { unlimited: false, balance_usd: 4.5 } }), { status: 200 })
      : new Response(JSON.stringify({ data: { window_days: 7, totals: { calls: 2 } } }), { status: 200 }));
    await aiGatewayUsage(config, { days: '7' }, fetchImpl as never);
    const urls = fetchImpl.mock.calls.map((call) => String((call as unknown as [URL])[0]));
    expect(urls).toEqual(['https://clikdeploy.com/v1/usage?days=7', 'https://clikdeploy.com/v1/credits']);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer cd_live_key');
    expect(JSON.parse(String(write.mock.calls[0]![0]))).toEqual({
      apiUrl: 'https://clikdeploy.com', window_days: 7, totals: { calls: 2 }, credit: { unlimited: false, balance_usd: 4.5 },
    });
  });

  it('says what went wrong, and refuses a window the Gateway would not honour', async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Unauthorized', type: 'authentication_error' } }), { status: 401 }));
    await expect(aiGatewayUsage(config, {}, refused as never)).rejects.toThrow('ClikDeploy Gateway usage: Unauthorized');
    const missing = vi.fn(async () => new Response('Not Found', { status: 404 }));
    await expect(aiGatewayUsage(config, {}, missing as never)).rejects.toThrow('this Gateway does not report usage yet');
    await expect(aiGatewayUsage(config, { days: '120' }, refused as never)).rejects.toThrow('--days must be a whole number from 1 to 90');
  });
});

describe('gateway credit', () => {
  it('asks the Gateway for a checkout, opens it where there is a display, and reports it', async () => {
    bindGlobalFlags({ json: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { url: 'https://checkout.stripe.com/c/pay/cs_1', amountCents: 2500 } }), { status: 200 }));
    const open = vi.fn();
    await aiGatewayCredit(config, { amount: '25' }, { fetchImpl: fetchImpl as never, open, environment: { DISPLAY: ':0' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://clikdeploy.com/v1/credits/checkout');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ amountUsd: 25 });
    expect(open).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_1');
    expect(JSON.parse(String(write.mock.calls[0]![0]))).toMatchObject({ checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1', amountCents: 2500, opened: true });
  });

  it('prints the link without opening anything on a headless box, and refuses an amount out of range', async () => {
    bindGlobalFlags({ json: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { url: 'https://checkout.stripe.com/c/pay/cs_2', amountCents: 1000 } }), { status: 200 }));
    const open = vi.fn();
    await aiGatewayCredit(config, {}, { fetchImpl: fetchImpl as never, open, environment: {} });
    expect(open).not.toHaveBeenCalled();
    expect(JSON.parse(String(write.mock.calls[0]![0]))).toMatchObject({ checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_2', opened: false });
    await expect(aiGatewayCredit(config, { amount: '2' }, { fetchImpl: fetchImpl as never })).rejects.toThrow('--amount must be a whole number of dollars from 5 to 500');
  });
});

describe('gateway credit --auto-topup', () => {
  it('turns automatic top-up on or off with the account\'s own switch, and refuses anything else', async () => {
    bindGlobalFlags({ json: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { autoTopUpEnabled: false } }), { status: 200 }));
    await aiGatewayCredit(config, { autoTopup: 'off' }, { fetchImpl: fetchImpl as never });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://clikdeploy.com/v1/credits');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ autoTopUpEnabled: false });
    expect(JSON.parse(String(write.mock.calls[0]![0]))).toEqual({ apiUrl: 'https://clikdeploy.com', autoTopUpEnabled: false });
    await expect(aiGatewayCredit(config, { autoTopup: 'maybe' }, { fetchImpl: fetchImpl as never })).rejects.toThrow('--auto-topup must be on or off');
  });
});

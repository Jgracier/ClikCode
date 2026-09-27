import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/models/for-session.js', () => ({
  gatewayConnection: () => ({ baseUrl: 'https://clikdeploy.com', apiKey: 'cd_live_key' }),
}));

const { gatewayModelDetail, gatewayModels, gatewayPriceLabel, isAutomaticModelWord, resetGatewayModelCache } = await import('./models.js');
const { chooseGatewayModel } = await import('../commands/ai/sessions.js');

const LIST = {
  automatic: 'qwen/qwen3.8-27b',
  models: [
    { id: 'gpt-5.6-sol', access: 'subscription', providers: [{ provider: 'openai', access: 'subscription' }, { provider: 'openrouter', access: 'metered' }] },
    { id: 'qwen/qwen3.8-27b', access: 'free-tier', providers: [{ provider: 'groq', access: 'free-tier' }] },
    { id: 'claude-opus-5', access: 'metered', providers: [{ provider: 'aws-bedrock', access: 'metered' }] },
  ],
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => { resetGatewayModelCache(); vi.unstubAllGlobals(); });

describe('the Gateway\'s model list', () => {
  it('is read with the account\'s key, and kept briefly', async () => {
    const fetchImpl = vi.fn(async () => reply({ success: true, data: LIST }));
    expect(await gatewayModels({ fetchImpl: fetchImpl as never })).toEqual(LIST);
    await gatewayModels({ fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://clikdeploy.com/api/clikcode/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer cd_live_key');
    await gatewayModels({ fetchImpl: fetchImpl as never, fresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('says so when the Gateway predates model choice', async () => {
    await expect(gatewayModels({ fetchImpl: (async () => new Response('nope', { status: 404 })) as never }))
      .rejects.toThrow('this Gateway does not offer a model choice yet');
  });

  it('labels each model by the access it runs on first, and through whom', () => {
    expect(gatewayModelDetail(LIST.models[0] as never)).toBe('subscription · openai (+1 more)');
    expect(gatewayModelDetail(LIST.models[1] as never)).toBe('free · groq');
    expect(gatewayModelDetail(LIST.models[2] as never)).toBe('paid · aws-bedrock');
  });
});

describe('a Gateway model\'s price', () => {
  it('shows the full price, and the discounted price beside it while a discount runs', () => {
    expect(gatewayPriceLabel({ full: { inMTok: 4, outMTok: 20 }, discountPercent: 0, charged: { inMTok: 4, outMTok: 20 } })).toBe('$4/$20 per 1M');
    expect(gatewayPriceLabel({ full: { inMTok: 4, outMTok: 20 }, discountPercent: 25, charged: { inMTok: 3, outMTok: 15 } }))
      .toBe('$4/$20 → $3/$15 per 1M (25% off)');
    expect(gatewayPriceLabel({ full: { inMTok: 0.15, outMTok: 0.6 }, discountPercent: 0, charged: { inMTok: 0.15, outMTok: 0.6 } })).toBe('$0.15/$0.6 per 1M');
    expect(gatewayModelDetail({
      id: 'gpt-5.6-sol', access: 'metered', providers: [{ provider: 'nous', access: 'metered' }],
      price: { full: { inMTok: 4, outMTok: 20 }, discountPercent: 25, charged: { inMTok: 3, outMTok: 15 } },
    })).toBe('paid · nous · $4/$20 → $3/$15 per 1M (25% off)');
  });
});

describe('choosing a Gateway model', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => reply({ success: true, data: LIST }))); });

  it('takes an id on the list, by its full id or its last part, in any case', async () => {
    expect(await chooseGatewayModel('GPT-5.6-SOL')).toBe('gpt-5.6-sol');
    expect(await chooseGatewayModel('qwen3.8-27b')).toBe('qwen/qwen3.8-27b');
  });

  it('hands the choice back to the Gateway for auto and its synonyms', async () => {
    for (const word of ['auto', 'Automatic', 'default', 'gateway']) {
      expect(isAutomaticModelWord(word)).toBe(true);
      expect(await chooseGatewayModel(word)).toBeNull();
    }
  });

  it('refuses a model the Gateway does not offer, and suggests near ones', async () => {
    await expect(chooseGatewayModel('gpt-5.6')).rejects.toThrow('Did you mean: gpt-5.6-sol');
    await expect(chooseGatewayModel('nothing-like-it')).rejects.toThrow('gateway models');
  });
});

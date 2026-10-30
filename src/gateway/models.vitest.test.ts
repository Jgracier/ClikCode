import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const account = vi.hoisted(() => ({ key: 'cd_live_key' }));
vi.mock('../agent/models/for-session.js', () => ({
  gatewayConnection: () => ({ baseUrl: 'https://clikdeploy.com', apiKey: account.key }),
}));

const { gatewayModelDetail, gatewayModelForWord, gatewayModels, gatewayPriceLabel, isAutomaticModelWord, resetGatewayModelCache, sameGatewayModel } = await import('./models.js');
const { chooseGatewayModel } = await import('../commands/ai/sessions.js');

/** What the Gateway sends (GET /v1/models, OpenAI's list)... */
const WIRE = {
  object: 'list',
  data: [
    { id: 'auto', object: 'model', created: 0, owned_by: 'clikdeploy', context_length: 131_072, max_output_tokens: 16_000, capabilities: { vision: true } },
    {
      id: 'gpt-5.6-sol', object: 'model', created: 0, owned_by: 'openai', context_length: 400_000,
      pricing: { prompt: '0.000003', completion: '0.000015', input_per_mtok: 3, output_per_mtok: 15, full_input_per_mtok: 4, full_output_per_mtok: 20, discount_percent: 25 },
    },
    { id: 'qwen/qwen3.8-27b', object: 'model', created: 0, owned_by: 'qwen', context_length: 131_072, access: 'free' },
    {
      id: 'claude-opus-5', object: 'model', created: 0, owned_by: 'anthropic', type: 'chat',
      capabilities: { tools: true, vision: true, reasoning: true, json_output: true }, max_output_tokens: 64000, tokens_per_second: 71.3,
    },
    { id: 'text-embedding-3-small', object: 'model', created: 0, owned_by: 'openai', type: 'embedding', dimensions: 1536 },
  ],
};
/** ...and the list ClikCode makes of it. */
const LIST = {
  auto: { contextWindow: 131_072, maxOutput: 16_000, vision: true },
  models: [
    { id: 'gpt-5.6-sol', maker: 'openai', contextWindow: 400_000, price: { full: { inMTok: 4, outMTok: 20 }, discountPercent: 25, charged: { inMTok: 3, outMTok: 15 } } },
    { id: 'qwen/qwen3.8-27b', maker: 'qwen', access: 'free', contextWindow: 131_072 },
    { id: 'claude-opus-5', maker: 'anthropic', vision: true, reasoning: true, maxOutput: 64000, tokensPerSecond: 71.3 },
  ],
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// The list is saved to disk (savedGatewayModels): never into the real ~/.clikcode.
const home = mkdtempSync(join(tmpdir(), 'cc-gw-models-'));
beforeEach(() => { process.env.CLIKCODE_HOME = home; rmSync(join(home, 'cache'), { recursive: true, force: true }); resetGatewayModelCache(); account.key = 'cd_live_key'; vi.unstubAllGlobals(); });
afterAll(() => { delete process.env.CLIKCODE_HOME; rmSync(home, { recursive: true, force: true }); });

describe('a Gateway that never answers the model list', () => {
  const hang = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as never;

  it('gives the last saved list once the timeout passes', async () => {
    await gatewayModels({ fetchImpl: (async () => reply(WIRE)) as never });
    resetGatewayModelCache();
    expect(await gatewayModels({ fetchImpl: hang, timeoutMs: 20, fresh: true })).toEqual(LIST);
  });

  it('fails, rather than waiting forever, when nothing was saved', async () => {
    await expect(gatewayModels({ fetchImpl: hang, timeoutMs: 20 })).rejects.toBeDefined();
  });
});

describe('the Gateway\'s model list', () => {
  it('is read with the account\'s key, and kept briefly', async () => {
    const fetchImpl = vi.fn(async () => reply(WIRE));
    expect(await gatewayModels({ fetchImpl: fetchImpl as never })).toEqual(LIST);
    await gatewayModels({ fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://clikdeploy.com/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer cd_live_key');
    await gatewayModels({ fetchImpl: fetchImpl as never, fresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // The super admin's switch (subscriptions.ts): sent as asked, its state read back only when the
  // Gateway reports it -- which it does for the super admin alone -- and each position its own list.
  it('sends the subscription switch, reads back its state, and keeps one list per position', async () => {
    let on = true;
    const config = { get: (key: string) => (key === 'gatewaySubscriptions' ? on : undefined) } as never;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => reply({
      ...WIRE, clikcode: { subscriptions: (init.headers as Record<string, string>)['x-clikcode-subscriptions'] === 'on' },
    }));
    expect((await gatewayModels({ fetchImpl: fetchImpl as never, config })).subscriptions).toBe(true);
    on = false;
    const off = await gatewayModels({ fetchImpl: fetchImpl as never, config });
    expect(off.subscriptions).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<string, string>)['x-clikcode-subscriptions']).toBe('off');
    // A customer's list carries no switch.
    expect(await gatewayModels({ fetchImpl: (async () => reply(WIRE)) as never, config, fresh: true })).not.toHaveProperty('subscriptions');
  });

  it('says so when the Gateway predates model choice', async () => {
    await expect(gatewayModels({ fetchImpl: (async () => new Response('nope', { status: 404 })) as never }))
      .rejects.toThrow('this Gateway does not offer a model choice yet');
  });

  it('shows a model by its price only: which provider serves it is the Gateway\'s decision', () => {
    expect(gatewayModelDetail(LIST.models[1] as never)).toBe('');
    expect(gatewayModelDetail({ ...LIST.models[1], price: { full: { inMTok: 4, outMTok: 20 }, discountPercent: 0, charged: { inMTok: 4, outMTok: 20 } } } as never))
      .toBe('$4/$20 per 1M');
  });

  it('names the tier serving a model beside it, where the Gateway says which (the super admin\'s list)', async () => {
    const { gatewayModelLabel, fromOpenAIModelList } = await import('./models.js');
    expect(gatewayModelLabel({ id: 'claude-opus-5-5', access: 'subscription' })).toBe('claude-opus-5-5 (subscription)');
    expect(gatewayModelLabel({ id: 'glm-5' })).toBe('glm-5');
    expect(fromOpenAIModelList([{ id: 'x', access: 'somewhere' }]).models[0]).toEqual({ id: 'x' });
  });

  it('carries the Gateway\'s uncensored tag into the row, so /model search for "uncensored" finds the model', async () => {
    const { fromOpenAIModelList } = await import('./models.js');
    const list = fromOpenAIModelList([
      { id: 'z-ai/glm-5.3-flash-uncensored', owned_by: 'zhipu', tags: ['uncensored'], pricing: { input_per_mtok: 0.2, output_per_mtok: 0.8 } },
      { id: 'gpt-5.6-sol', owned_by: 'openai' },
    ]);
    const [tagged, ordinary] = list.models;
    expect(tagged!.tags).toEqual(['uncensored']);
    expect(gatewayModelDetail(tagged!)).toMatch(/^uncensored/);
    expect(ordinary!.tags).toBeUndefined();
    expect(gatewayModelDetail(ordinary!)).not.toMatch(/uncensored/);
    // A tag the Gateway sends that is not a string is ignored, not crashed on.
    expect(fromOpenAIModelList([{ id: 'x', tags: [1, null] }]).models[0]).toEqual({ id: 'x' });
  });

  it('keeps a private deployment as its own choice, named by the model it serves', async () => {
    const { fromOpenAIModelList, gatewayModelLabel } = await import('./models.js');
    const model = fromOpenAIModelList([{
      id: 'private-deployment:dep-7', owned_by: 'self-hosted', capabilities: { tools: true },
      deployment: { id: 'dep-7', modelId: 'Qwen/Qwen3.8-27B', state: 'starting' },
    }]).models[0]!;
    expect(model.id).toBe('private-deployment:dep-7');
    expect(gatewayModelLabel(model)).toBe('Qwen/Qwen3.8-27B (Hosted AI)');
  });

  it('keeps the last list on disk, so /model opens at once from it', async () => {
    const { savedGatewayModels } = await import('./models.js');
    expect(await savedGatewayModels()).toBeUndefined();
    await gatewayModels({ fetchImpl: (async () => reply(WIRE)) as never });
    expect(await savedGatewayModels()).toEqual(LIST);
  });

  it('does not reuse another account\'s model list or prices', async () => {
    const { savedGatewayModels } = await import('./models.js');
    const fetchImpl = vi.fn(async () => reply(WIRE));
    await gatewayModels({ fetchImpl: fetchImpl as never });
    account.key = 'another-account-key';
    expect(await savedGatewayModels()).toBeUndefined();
    await gatewayModels({ fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('a Gateway model\'s price', () => {
  it('shows the full price, and the discounted price beside it while a discount runs', () => {
    expect(gatewayPriceLabel({ full: { inMTok: 4, outMTok: 20 }, discountPercent: 0, charged: { inMTok: 4, outMTok: 20 } })).toBe('$4/$20 per 1M');
    expect(gatewayPriceLabel({ full: { inMTok: 4, outMTok: 20 }, discountPercent: 25, charged: { inMTok: 3, outMTok: 15 } }))
      .toBe('$4/$20 → $3/$15 per 1M (25% off)');
    expect(gatewayPriceLabel({ full: { inMTok: 0.15, outMTok: 0.6 }, discountPercent: 0, charged: { inMTok: 0.15, outMTok: 0.6 } })).toBe('$0.15/$0.6 per 1M');
    expect(gatewayModelDetail({
      id: 'gpt-5.6-sol',
      price: { full: { inMTok: 4, outMTok: 20 }, discountPercent: 25, charged: { inMTok: 3, outMTok: 15 } },
    })).toBe('$4/$20 → $3/$15 per 1M (25% off)');
  });
});

describe('choosing a Gateway model', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => reply(WIRE))); });

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

  it('looks a missing model up once more on a fresh list before refusing it', async () => {
    // The Gateway's instances answer with different lists from one moment to the next.
    resetGatewayModelCache();
    const partial = { ...WIRE, data: WIRE.data.filter((entry) => entry.id !== 'claude-opus-5') };
    const fetchMock = vi.fn(async () => reply(partial)).mockImplementationOnce(async () => reply(partial)).mockImplementationOnce(async () => reply(WIRE));
    vi.stubGlobal('fetch', fetchMock);
    expect(await chooseGatewayModel('claude-opus-5')).toBe('claude-opus-5');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('takes an id however it is spelled, and a vendor word as the newest model it names', async () => {
    const models = [{ id: 'claude-opus-5' }, { id: 'claude-opus-5.5-fast' }, { id: 'claude-opus-5.5' }, { id: 'claude-sonnet-5' }, { id: 'claude-opus-4.8' }];
    expect(sameGatewayModel('claude-opus-5-5', 'anthropic/Claude-Opus-5.5')).toBe(true);
    expect(gatewayModelForWord(models, 'claude-opus-5-5')?.id).toBe('claude-opus-5.5');
    // A Claude Code alias carried onto the Gateway: its newest model, never the dearer -fast lane first.
    expect(gatewayModelForWord(models, 'opus')?.id).toBe('claude-opus-5.5');
    expect(gatewayModelForWord(models, 'sonnet')?.id).toBe('claude-sonnet-5');
    expect(gatewayModelForWord(models, 'haiku')).toBeUndefined();
    expect(await chooseGatewayModel('opus')).toBe('claude-opus-5');
  });

  it('refuses a model the Gateway does not offer, and suggests near ones', async () => {
    await expect(chooseGatewayModel('gpt-5.6')).rejects.toThrow('Did you mean: gpt-5.6-sol');
    await expect(chooseGatewayModel('nothing-like-it')).rejects.toThrow('gateway models');
  });
});

describe('models by maker', () => {
  it('orders by the lab that made them, unknown last, and names the lab', async () => {
    const { gatewayModelsByMaker, gatewayMakerName } = await import('./models.js');
    const models = [{ id: 'x' }, { id: 'g', maker: 'openai' }, { id: 'c', maker: 'anthropic' }, { id: 'c2', maker: 'anthropic' }, { id: 'n', maker: 'nvidia' }];
    expect(gatewayModelsByMaker(models).map((model) => model.id)).toEqual(['c', 'c2', 'n', 'g', 'x']);
    expect(gatewayMakerName(models[1]!)).toBe('OpenAI');
    expect(gatewayMakerName(models[0]!)).toBe('Other');
    expect(gatewayMakerName({ id: 'm', maker: 'mistral' })).toBe('Mistral');
  });

  it("lists the user's own models first, as theirs, with how they are", async () => {
    const { fromOpenAIModelList, gatewayMakerName, gatewayModelsByMaker, gatewayModelDetail } = await import('./models.js');
    const { models } = fromOpenAIModelList([
      { id: 'gpt-5', owned_by: 'openai' },
      { id: 'Qwen/Qwen3-8B', owned_by: 'self-hosted', capabilities: { tools: true }, context_length: 32768, deployment: { id: 'd1', state: 'asleep' } },
      { id: 'odd/model', owned_by: 'self-hosted', capabilities: { tools: false }, deployment: { id: 'd2', state: 'running' } },
    ]);
    expect(models[1]).toEqual({ id: 'Qwen/Qwen3-8B', own: { state: 'asleep', tools: true }, contextWindow: 32768 });
    const ordered = gatewayModelsByMaker(models);
    expect(ordered.map((model) => model.id)).toEqual(['Qwen/Qwen3-8B', 'odd/model', 'gpt-5']);
    expect(gatewayMakerName(ordered[0]!)).toBe('Your models');
    expect(gatewayModelDetail(ordered[0]!)).toBe('asleep: wakes when used (a few minutes) · on your compute, no per-token charge');
    expect(gatewayModelDetail(ordered[1]!)).toBe('running · on your compute, no per-token charge · no tool calls');
  });
});


it('shows the effective rate without a promotion, for both operator cost and retail markup', () => {
  expect(gatewayPriceLabel({ full: { inMTok: 4, outMTok: 20 }, charged: { inMTok: 1, outMTok: 2 }, discountPercent: 0 })).toBe('$1/$2 per 1M');
  expect(gatewayPriceLabel({ full: { inMTok: 4, outMTok: 20 }, charged: { inMTok: 5, outMTok: 25 }, discountPercent: 0 })).toBe('$5/$25 per 1M');
});

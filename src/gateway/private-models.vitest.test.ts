import { afterEach, describe, expect, it, vi } from 'vitest';
import { deployPrivateModel } from './private-models.js';

vi.mock('../agent/models/for-session.js', () => ({
  gatewayConnection: () => ({ baseUrl: 'https://gateway.test', apiKey: 'test-key' }),
}));

afterEach(() => vi.unstubAllGlobals());

describe('private model deployment selection', () => {
  const model = { sourceId: 'huggingface', modelId: 'owner/model', displayName: 'model', gated: false };
  const quote = { quant: { label: 'Q8_0' } } as Parameters<typeof deployPrivateModel>[1];

  it('addresses the created deployment rather than its public model name', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { id: 'dep-1', modelId: model.modelId, status: 'LOADING' } }));
    vi.stubGlobal('fetch', fetcher);
    const deployment = await deployPrivateModel(model, quote);
    expect(deployment.gatewayModelId).toBe('private-deployment:dep-1');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ sourceId: 'huggingface', modelId: model.modelId, quantLabel: 'Q8_0' });
  });

  it('refuses an invalid create response instead of selecting a hosted model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: { modelId: model.modelId } })));
    await expect(deployPrivateModel(model, quote)).rejects.toThrow('without an ID');
  });
});

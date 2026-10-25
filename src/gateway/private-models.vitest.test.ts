import { afterEach, describe, expect, it, vi } from 'vitest';
import { deployPrivateModel, quoteSummary } from './private-models.js';

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

describe('quoteSummary', () => {
  const quote = {
    manifest: { displayName: 'Qwen3-14B', quantizations: [] }, quant: { label: 'bf16' }, runtime: { name: 'vLLM' },
    vram: { totalGb: 38.2 }, sku: { displayName: '1 GPU · 47 GB' }, pricePerHour: 0.51,
    throughput: { decodeTokensPerSec: 18.9 }, servingContext: { tokens: 32768 }, warnings: ['BF16 would need about 158 GB of GPU memory, more than one GPU holds; using F16, the most precise version that fits one.'],
  };

  it('puts the GPU, the price, the model, the speed and what the planner flagged on separate lines, so each can wrap in full', () => {
    const { title, body } = quoteSummary({ modelId: 'Qwen/Qwen3-14B', displayName: 'Qwen3-14B' }, quote);
    expect(title).toBe('Qwen3-14B on ClikDeploy');
    expect(body.split('\n')).toEqual([
      'GPU: 1 GPU · 47 GB',
      'Price: $0.51 per hour while it runs; nothing once it is stopped',
      'Model: bf16 · vLLM · needs about 39 GB of GPU memory',
      'Speed: about 19 tokens per second (estimate)',
      'Context: 32,768 tokens',
      'Note: BF16 would need about 158 GB of GPU memory, more than one GPU holds; using F16, the most precise version that fits one.',
    ]);
  });

  it('leaves out what the quote does not carry', () => {
    const { body } = quoteSummary({ modelId: 'a/b', displayName: '' }, { manifest: { displayName: 'b', quantizations: [] }, quant: null, runtime: { name: 'vLLM' }, vram: { totalGb: 0 }, sku: { displayName: 'GPU' }, pricePerHour: 1 });
    expect(body.split('\n')).toEqual(['GPU: GPU', 'Price: $1.00 per hour while it runs; nothing once it is stopped', 'Model: vLLM']);
  });
});

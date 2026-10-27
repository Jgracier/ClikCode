/** ClikDeploy's side of Hosted AI: how its price is worded, the one line a choice between here and there shows, and that a price nobody
 * is waiting for any more is not waited for. ClikDeploy itself is stood in for. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/models/for-session.js', () => ({ gatewayConnection: () => ({ baseUrl: 'https://gateway.test', apiKey: 'key' }) }));
vi.mock('conf', () => ({ default: class { get(): undefined { return undefined; } } }));

const { clikdeploy, perHour } = await import('./clikdeploy.js');
const { quotePrivateModel } = await import('../gateway/private-models.js');

const QUOTE = {
  manifest: { displayName: 'Qwen3.5 4B', quantizations: [] }, quant: { label: 'BF16' }, runtime: { name: 'vllm' }, vram: { totalGb: 17 },
  sku: { displayName: '1 GPU · 17 GB' }, pricePerHour: 0.068, throughput: { decodeTokensPerSec: 52.4 }, servingContext: { tokens: 32768 },
};
const respond = (status: number, data: unknown) => new Response(JSON.stringify(status < 300 ? { data } : { error: data }), { status, headers: { 'content-type': 'application/json' } });

let calls: Array<{ url: string; signal?: AbortSignal | null }>;
beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('the price per hour', () => {
  it('keeps a third decimal for a small model, where a cent is a lot, and two for the rest', () => {
    expect(perHour(0.068)).toBe('$0.068/hour');
    expect(perHour(0.025)).toBe('$0.025/hour');
    expect(perHour(0.09)).toBe('$0.09/hour');
    expect(perHour(0.1)).toBe('$0.10/hour');
    expect(perHour(0.5)).toBe('$0.50/hour');
    expect(perHour(1.013)).toBe('$1.01/hour');
  });
});

describe('the ClikDeploy plan for a model', () => {
  it('says the price, what it runs on and the speed in one line a question can show beside "run on this computer"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, signal: init.signal }); return respond(200, QUOTE); }));
    const plan = await clikdeploy.plan({ target: 'clikdeploy', id: 'unsloth/Qwen3.5-4B-GGUF', label: 'Qwen3.5 4B', detail: '' });
    expect(plan).toMatchObject({ costly: true, confirm: 'Start · $0.068/hour', summary: '$0.068/hour · 1 GPU · 17 GB · ~52 tok/s' });
    expect(calls[0]!.url).toContain('/api/models/resolve?source=huggingface&modelId=unsloth%2FQwen3.5-4B-GGUF');
  });

  it('leaves out a speed the planner did not estimate', async () => {
    const { throughput: _gone, ...bare } = QUOTE;
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, bare)));
    expect((await clikdeploy.plan({ target: 'clikdeploy', id: 'a/b', label: 'b', detail: '' })).summary).toBe('$0.068/hour · 1 GPU · 17 GB');
  });

  it('stops the request when the caller no longer wants the answer', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const wanted = new AbortController();
    const pending = quotePrivateModel('a/b', wanted.signal);
    wanted.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it('tells a gated model how to get access, in the message of the plan', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(400, "Model 'a/b' is gated on huggingface — connect your account to deploy it.")));
    await expect(clikdeploy.plan({ target: 'clikdeploy', id: 'a/b', label: 'b', detail: '', gated: true })).rejects.toThrow(/Connect Hugging Face in ClikDeploy/);
  });
});

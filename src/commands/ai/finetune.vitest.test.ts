import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindGlobalFlags } from '../../cli/output-mode.js';

vi.mock('../../gateway/credentials.js', () => ({ getApiUrl: () => 'https://clikdeploy.com', getApiKeyForUrl: () => 'cd_live_key' }));

const { aiGatewayFineTune } = await import('./finetune.js');
const config = {} as never;

let dir: string;
let dataset: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'finetune-'));
  dataset = join(dir, 'tiny.jsonl');
  await writeFile(dataset, '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}]}\n');
  bindGlobalFlags({ json: true });
});
afterEach(async () => { vi.restoreAllMocks(); bindGlobalFlags({}); process.exitCode = undefined; await rm(dir, { recursive: true, force: true }); });

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
const QUOTE = { summary: 'Roughly $0.00–$0.01 · about 15 min–40 min', hardware: 'cpu', costHigh: 0.01, hoursLow: 0.25, hoursHigh: 0.66, warnings: ['If one of your own connected machines can run it, it runs there at no charge.'], costHighMicroUsd: '10000', suggestedCeilingMicroUsd: '2000000', sku: { displayName: '8 vCPU · 11 GB' } };

/** A fake ClikDeploy: the dataset upload, the quote, the job, and its status over time. */
function server(statuses: Array<Record<string, unknown>> = [{ id: 'job-1', status: 'COMPLETE', statusDetail: 'Ready — the trained model is in your store.', spendMicroUsd: '14400', outputPath: 'store:ft-job-1/merged/' }]) {
  const seen: Array<{ method: string; path: string; body?: unknown; headers: Record<string, string> }> = [];
  const polls = [...statuses];
  const fetchImpl = vi.fn(async (url: URL, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    const method = init.method ?? 'GET';
    seen.push({ method, path, headers: init.headers as Record<string, string>, ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : init.body instanceof FormData ? { body: Object.fromEntries([...init.body.keys()].map((key) => [key, init.body instanceof FormData ? (init.body.get(key) instanceof File ? 'file' : init.body.get(key)) : undefined])) } : {}) });
    if (path === '/api/datasets') return ok({ id: 'ds-1', rowCount: 1, tokenCount: 9, format: 'JSONL_CHAT' }, 201);
    if (path === '/api/training/quote') return ok(QUOTE);
    if (path === '/api/training/jobs' && method === 'POST') return ok({ id: 'job-1', status: 'PREPARING' }, 201);
    if (path === '/api/training/jobs/job-1') return ok(polls.length > 1 ? polls.shift() : polls[0]);
    return new Response('{}', { status: 404 });
  });
  return { fetchImpl: fetchImpl as never, seen };
}
const output = () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return () => write.mock.calls.map((call) => JSON.parse(String(call[0])));
};

describe('gateway finetune', () => {
  it('shows the quote and starts nothing without --yes, having uploaded the dataset only', async () => {
    const results = output();
    const { fetchImpl, seen } = server();
    await aiGatewayFineTune(config, dataset, { base: 'Qwen/Qwen2.5-0.5B-Instruct', hardware: 'cpu' }, { fetchImpl, progress: () => {} });
    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/datasets', 'POST /api/training/quote']);
    expect(seen[0]!.headers.authorization).toBe('Bearer cd_live_key');
    expect(seen[1]!.body).toEqual({ baseModelId: 'Qwen/Qwen2.5-0.5B-Instruct', datasetId: 'ds-1', hardware: 'cpu' });
    expect(results()[0]).toMatchObject({ started: false, quote: { hardware: 'cpu', machine: '8 vCPU · 11 GB', mostItCanCostUsd: 0.01 }, dataset: { id: 'ds-1', rows: 1 } });
    expect(results()[0].next).toContain('--yes');
  });

  it('with --yes starts the job at the quoted price as its ceiling, follows it to the end, and reports what it cost and where the weights are', async () => {
    const results = output();
    const lines: string[] = [];
    const { fetchImpl, seen } = server([
      { id: 'job-1', status: 'PREPARING', statusDetail: 'Getting a machine…' },
      { id: 'job-1', status: 'TRAINING', statusDetail: 'Training — step 3 of 20' },
      { id: 'job-1', status: 'COMPLETE', statusDetail: 'Ready — the trained model is in your store.', spendMicroUsd: '14400' },
    ]);
    await aiGatewayFineTune(config, dataset, { base: 'Qwen/Qwen2.5-0.5B-Instruct', hardware: 'cpu', epochs: '1', yes: true, name: 'support' }, { fetchImpl, sleep: async () => {}, progress: (line) => lines.push(line) });
    const start = seen.find((call) => call.method === 'POST' && call.path === '/api/training/jobs')!;
    expect(start.body).toMatchObject({ baseModelId: 'Qwen/Qwen2.5-0.5B-Instruct', hardware: 'cpu', placement: 'capacity', acceptedQuoteMicroUsd: '10000', spendCeilingMicroUsd: '2000000', hyperparams: { epochs: 1 }, name: 'support' });
    expect(lines).toEqual(expect.arrayContaining(['PREPARING · Getting a machine…', 'TRAINING · Training — step 3 of 20']));
    expect(results().at(-1)).toMatchObject({ started: true, job: { id: 'job-1', status: 'COMPLETE', spentUsd: 0.0144, weights: expect.stringContaining('yours to keep') } });
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 when the job ends in error, with its reason', async () => {
    const results = output();
    const { fetchImpl } = server([{ id: 'job-1', status: 'ERROR', statusDetail: 'Training failed.' }]);
    await aiGatewayFineTune(config, dataset, { base: 'x/y', yes: true }, { fetchImpl, sleep: async () => {}, progress: () => {} });
    expect(results().at(-1)).toMatchObject({ job: { status: 'ERROR', detail: 'Training failed.' } });
    expect(process.exitCode).toBe(1);
  });

  it('with --no-wait returns as soon as the job is started', async () => {
    const results = output();
    const { fetchImpl, seen } = server();
    await aiGatewayFineTune(config, dataset, { base: 'x/y', yes: true, wait: false }, { fetchImpl, progress: () => {} });
    expect(seen.map((call) => call.path)).not.toContain('/api/training/jobs/job-1');
    expect(results().at(-1)).toMatchObject({ started: true, job: { id: 'job-1', status: 'PREPARING' } });
  });

  it("says what ClikDeploy said when it refuses (a model too large for a CPU), and checks its own arguments first", async () => {
    const refusing = vi.fn(async (url: URL) => new URL(String(url)).pathname === '/api/datasets'
      ? ok({ id: 'ds-1' }, 201)
      : new Response(JSON.stringify({ success: false, error: 'A 7B model is too large to train on a CPU (the limit is 1.5B). Train it on a GPU instead.' }), { status: 400 }));
    await expect(aiGatewayFineTune(config, dataset, { base: 'big/7b', hardware: 'cpu' }, { fetchImpl: refusing as never })).rejects.toThrow('ClikDeploy fine-tune: A 7B model is too large to train on a CPU');
    const never = vi.fn();
    await expect(aiGatewayFineTune(config, dataset, {}, { fetchImpl: never as never })).rejects.toThrow('--base');
    await expect(aiGatewayFineTune(config, dataset, { base: 'x/y', hardware: 'tpu' }, { fetchImpl: never as never })).rejects.toThrow('--hardware must be gpu or cpu');
    await expect(aiGatewayFineTune(config, dataset, { base: 'x/y', epochs: '20' }, { fetchImpl: never as never })).rejects.toThrow('--epochs');
    await expect(aiGatewayFineTune(config, join(dir, 'missing.jsonl'), { base: 'x/y' }, { fetchImpl: never as never })).rejects.toThrow('No dataset file');
    expect(never).not.toHaveBeenCalled();
  });
});

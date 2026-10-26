/** Discovery never makes the model list wait for Hugging Face: what is known is listed at once, a refresh runs behind
 * it, no header is read twice, and a Hub that cannot be reached is not asked again at every open. A fake Hub stands in. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GGMLQuantizationType, type GGUFParseOutput } from '@huggingface/gguf';
import { allLocalModels, registerRemoteModels } from './catalog.js';
import { discoverHuggingFaceModels, discoveryRefresh, weightCapacityBytes, type DiscoverDeps } from './discover.js';
import { discoveredModelsFile } from './paths.js';
import { hostedList } from '../hosted-models/index.js';

const SHA = 'a'.repeat(40);
const FILE = { rfilename: 'model-Q4_K_M.gguf', lfs: { sha256: 'b'.repeat(64), size: 1_000_000_000 } };
const HEADER = {
  metadata: {
    'general.architecture': 'qwen35moe', 'qwen35moe.block_count': 8, 'qwen35moe.context_length': 65_536,
    'qwen35moe.attention.head_count_kv': 2, 'qwen35moe.attention.key_length': 128, 'qwen35moe.attention.value_length': 128,
    'qwen35moe.full_attention_interval': 4, 'qwen35moe.ssm.inner_size': 256, 'qwen35moe.ssm.state_size': 128,
    'qwen35moe.ssm.group_count': 2, 'qwen35moe.expert_count': 4, 'qwen35moe.expert_used_count': 1,
    'tokenizer.chat_template': '{% if tools %}tool_call{% endif %}',
  },
  tensorInfos: [
    { name: 'output.weight', shape: [100n], dtype: GGMLQuantizationType.F16 },
    { name: 'token_embd.weight', shape: [100n], dtype: GGMLQuantizationType.F16 },
    { name: 'blk.0.ffn_up_exps.weight', shape: [1024n], dtype: GGMLQuantizationType.Q4_K },
  ],
} as GGUFParseOutput;
const ID = `hf:example/model-GGUF:${SHA.slice(0, 12)}:${FILE.rfilename}`;
const CAPACITY = 64e9;
const DAY = 24 * 60 * 60 * 1000;

/** A Hub with one repo carrying one candidate. `header` decides what reading it does. */
function fakeHub(options: { header?: () => Promise<GGUFParseOutput>; searchFails?: boolean } = {}) {
  const calls = { json: 0, header: 0 };
  let clock = 1_000_000_000_000;
  const deps: DiscoverDeps = {
    async json<T>(url: string): Promise<T> {
      calls.json += 1;
      if (options.searchFails) throw new Error('offline');
      if (url.includes('/api/models?')) return [{ id: 'example/model-GGUF', downloads: 10 }] as T;
      return { id: 'example/model-GGUF', sha: SHA, cardData: { license: 'apache-2.0' }, siblings: [FILE] } as T;
    },
    async header() { calls.header += 1; return options.header ? options.header() : HEADER; },
    now: () => clock,
  };
  return { deps, calls, advance: (ms: number) => { clock += ms; } };
}

const cacheOnDisk = (): { at?: number; failedAt?: number; incomplete?: boolean; models?: Array<{ id: string }>; rejected?: string[] } =>
  JSON.parse(readFileSync(discoveredModelsFile(), 'utf8'));

let home: string;
const saved = process.env.CLIKCODE_LOCAL_MODELS_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cc-discover-')); process.env.CLIKCODE_LOCAL_MODELS_HOME = home; registerRemoteModels([]); });
afterEach(async () => {
  await discoveryRefresh()?.catch(() => undefined);
  registerRemoteModels([]);
  if (saved === undefined) delete process.env.CLIKCODE_LOCAL_MODELS_HOME; else process.env.CLIKCODE_LOCAL_MODELS_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe('discovering Hugging Face models', () => {
  it('lists at once with nothing known, while the headers are still being read, and has them after', async () => {
    let finish!: () => void;
    const hub = fakeHub({ header: () => new Promise((resolve) => { finish = () => resolve(HEADER); }) });
    const listed = await discoverHuggingFaceModels(CAPACITY, {}, hub.deps);
    // Returned with the header unread: the list did not wait for it.
    expect(listed.some((model) => model.id === ID)).toBe(false);
    expect(discoveryRefresh()).toBeDefined();
    await vi_waitFor(() => hub.calls.header === 1);
    finish();
    expect(await discoveryRefresh()).toBe(true);
    expect(allLocalModels().some((model) => model.id === ID)).toBe(true);
    expect(cacheOnDisk().models?.map((model) => model.id)).toEqual([ID]);
  });

  it('asks nothing of the Hub while the cache is good', async () => {
    const hub = fakeHub();
    await discoverHuggingFaceModels(CAPACITY, { wait: true }, hub.deps);
    const before = { ...hub.calls };
    hub.advance(DAY / 2);
    const listed = await discoverHuggingFaceModels(CAPACITY, { wait: true }, hub.deps);
    expect(hub.calls).toEqual(before);
    expect(listed.some((model) => model.id === ID)).toBe(true);
  });

  it('lists a stale cache at once, refreshes behind it, and never reads a header it already has', async () => {
    const hub = fakeHub();
    await discoverHuggingFaceModels(CAPACITY, { wait: true }, hub.deps);
    expect(hub.calls.header).toBe(1);
    hub.advance(3 * DAY);
    registerRemoteModels([]);
    const listed = await discoverHuggingFaceModels(CAPACITY, {}, hub.deps);
    // Listed from the cache, however old, before the refresh has done anything.
    expect(listed.some((model) => model.id === ID)).toBe(true);
    expect(await discoveryRefresh()).toBe(false);
    expect(hub.calls.header).toBe(1);
    expect(hub.calls.json).toBeGreaterThan(6);
  });

  it('does not depend on how much memory is free: a bigger budget than the cache was made for refreshes, a smaller one does not', async () => {
    const hub = fakeHub();
    await discoverHuggingFaceModels(CAPACITY, { wait: true }, hub.deps);
    const searches = hub.calls.json;
    await discoverHuggingFaceModels(CAPACITY * 0.95, { wait: true }, hub.deps);
    expect(hub.calls.json).toBe(searches);
    await discoverHuggingFaceModels(CAPACITY * 2, { wait: true }, hub.deps);
    expect(hub.calls.json).toBeGreaterThan(searches);
  });

  it('is not asked again at every open when the Hub cannot be reached, and keeps what it knew', async () => {
    const ok = fakeHub();
    await discoverHuggingFaceModels(CAPACITY, { wait: true }, ok.deps);
    ok.advance(3 * DAY);
    const down = fakeHub({ searchFails: true });
    down.advance(3 * DAY);
    const listed = await discoverHuggingFaceModels(CAPACITY, { wait: true }, { ...down.deps, now: () => ok.deps.now() });
    expect(listed.some((model) => model.id === ID)).toBe(true);
    expect(cacheOnDisk().failedAt).toBeDefined();
    const tried = down.calls.json;
    await discoverHuggingFaceModels(CAPACITY, { wait: true }, { ...down.deps, now: () => ok.deps.now() + 60_000 });
    expect(down.calls.json).toBe(tried);
    // Half an hour on, it tries again.
    await discoverHuggingFaceModels(CAPACITY, { wait: true }, { ...down.deps, now: () => ok.deps.now() + 31 * 60_000 });
    expect(down.calls.json).toBeGreaterThan(tried);
  });

  it('is not told a model is bad by a header it could not read: that one is tried again soon', async () => {
    let healthy = false;
    const hub = fakeHub({ header: async () => { if (!healthy) throw new Error('reset'); return HEADER; } });
    await discoverHuggingFaceModels(CAPACITY, { wait: true }, hub.deps);
    expect(cacheOnDisk().models ?? []).toEqual([]);
    expect(cacheOnDisk().rejected ?? []).toEqual([]);
    healthy = true;
    hub.advance(31 * 60_000);
    expect(await (async () => { await discoverHuggingFaceModels(CAPACITY, { wait: true }, hub.deps); return discoveryRefresh(); })()).toBeUndefined();
    expect(allLocalModels().some((model) => model.id === ID)).toBe(true);
  });

  it('tells the Hosted AI list it is still looking, so the list asks again, and stops saying so when it is done', async () => {
    let finish!: () => void;
    const hub = fakeHub({ header: () => new Promise((resolve) => { finish = () => resolve(HEADER); }) });
    await discoverHuggingFaceModels(CAPACITY, {}, hub.deps);
    await vi_waitFor(() => hub.calls.header === 1);
    expect((await hostedList('', [])).refreshing).toBe(true);
    finish();
    await discoveryRefresh();
    expect((await hostedList('', [])).refreshing).toBeUndefined();
  });

  it('leaves a process that is about to exit alone', async () => {
    const hub = fakeHub();
    await discoverHuggingFaceModels(CAPACITY, { refresh: 'never' }, hub.deps);
    expect(hub.calls.json).toBe(0);
    expect(discoveryRefresh()).toBeUndefined();
  });
});

describe('what a machine could hold', () => {
  const gpu = (over: Record<string, unknown>) => ({ name: 'g', backend: 'cuda', vramBytes: 24e9, ...over });
  it('is its memory plus a dedicated card, not what is free, and not a card that shares memory', () => {
    expect(weightCapacityBytes({ totalRamBytes: 32e9, gpus: [] } as never)).toBe(32e9);
    expect(weightCapacityBytes({ totalRamBytes: 32e9, gpus: [gpu({})] } as never)).toBe(56e9);
    expect(weightCapacityBytes({ totalRamBytes: 32e9, gpus: [gpu({ unified: true }), gpu({ integrated: true })] } as never)).toBe(32e9);
  });
});

/** Waits until `condition` holds, briefly. */
async function vi_waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
}
void writeFileSync;

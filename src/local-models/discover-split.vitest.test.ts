/** Large models are published as GGUF parts (Hugging Face caps a file at 50 GB): discovery offers them as one model with every
 * part pinned, its size and parameters the whole model's, and what the user types is looked up on the Hub as well. A fake Hub
 * stands in. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GGMLQuantizationType, type GGUFParseOutput } from '@huggingface/gguf';
import { registerRemoteModels } from './catalog.js';
import { discoverHuggingFaceModels, discoveryRefresh, repoCandidates, type DiscoverDeps } from './discover.js';
import { ensureModelWeights, hubFileUrl, missingBytes, modelFilePath, weightFiles, type LocalModel } from './models.js';
import { discoveredModelsFile } from './paths.js';

const SHA = 'c'.repeat(40);
const GB = 1e9;
const part = (name: string, size: number, hash: string) => ({ rfilename: name, lfs: { sha256: hash.repeat(64), size } });
const PARTS = [
  part('Q4_K_M/big-Q4_K_M-00001-of-00003.gguf', 40 * GB, 'd'),
  part('Q4_K_M/big-Q4_K_M-00002-of-00003.gguf', 40 * GB, 'e'),
  part('Q4_K_M/big-Q4_K_M-00003-of-00003.gguf', 20 * GB, 'f'),
];
const METADATA = {
  'general.architecture': 'qwen35moe', 'general.name': 'Big', 'qwen35moe.block_count': 8, 'qwen35moe.context_length': 131_072,
  'qwen35moe.attention.head_count_kv': 2, 'qwen35moe.attention.key_length': 128, 'qwen35moe.attention.value_length': 128,
  'qwen35moe.full_attention_interval': 4, 'qwen35moe.ssm.inner_size': 256, 'qwen35moe.ssm.state_size': 128,
  'qwen35moe.ssm.group_count': 2, 'qwen35moe.expert_count': 4, 'qwen35moe.expert_used_count': 1,
  'tokenizer.chat_template': '{% if tools %}tool_call{% endif %}', 'split.count': 3,
};
const tensor = (name: string, n: bigint) => ({ name, shape: [n], dtype: GGMLQuantizationType.F16 });
/** The first part's header has the metadata and its own tensors; the others only theirs. */
const HEADERS: Record<string, GGUFParseOutput> = {
  [PARTS[0]!.rfilename]: { metadata: METADATA, tensorInfos: [tensor('output.weight', 1000n), tensor('token_embd.weight', 1000n)] } as unknown as GGUFParseOutput,
  [PARTS[1]!.rfilename]: { metadata: { 'split.count': 3 }, tensorInfos: [tensor('blk.0.attn_q.weight', 2000n)] } as unknown as GGUFParseOutput,
  [PARTS[2]!.rfilename]: { metadata: { 'split.count': 3 }, tensorInfos: [tensor('blk.1.attn_q.weight', 3000n)] } as unknown as GGUFParseOutput,
};
const DAY = 24 * 60 * 60 * 1000;

function fakeHub(options: { siblings?: typeof PARTS; searchFails?: boolean } = {}) {
  const searches: string[] = [];
  const headerUrls: string[] = [];
  let clock = 1_000_000_000_000;
  const deps: DiscoverDeps = {
    async json<T>(url: string): Promise<T> {
      if (url.includes('/api/models?')) {
        searches.push(new URL(url).searchParams.get('search') ?? '');
        if (options.searchFails) throw new Error('offline');
        return [{ id: 'example/big-GGUF', downloads: 10 }] as T;
      }
      return { id: 'example/big-GGUF', sha: SHA, cardData: { license: 'apache-2.0' }, siblings: options.siblings ?? PARTS } as T;
    },
    async header(url) {
      headerUrls.push(url);
      const name = decodeURIComponent(url.slice(url.indexOf(`/resolve/${SHA}/`) + `/resolve/${SHA}/`.length));
      return HEADERS[name]!;
    },
    now: () => clock,
  };
  return { deps, searches, headerUrls, advance: (ms: number) => { clock += ms; } };
}

let home: string;
const saved = process.env.CLIKCODE_LOCAL_MODELS_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cc-split-')); process.env.CLIKCODE_LOCAL_MODELS_HOME = home; registerRemoteModels([]); });
afterEach(async () => {
  await discoveryRefresh()?.catch(() => undefined);
  registerRemoteModels([]);
  if (saved === undefined) delete process.env.CLIKCODE_LOCAL_MODELS_HOME; else process.env.CLIKCODE_LOCAL_MODELS_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const repo = (siblings: Array<{ rfilename: string; lfs: { sha256: string; size: number } }>) =>
  ({ id: 'example/big-GGUF', sha: SHA, siblings });

describe('split GGUF models', () => {
  it('offers a split model only when every part is there, in one folder, numbered 1..N, and counts its whole size', () => {
    expect(repoCandidates(repo(PARTS), 200 * GB).map((c) => [c.file.rfilename, c.parts?.length, c.sizeBytes]))
      .toEqual([[PARTS[0]!.rfilename, 3, 100 * GB]]);
    expect(repoCandidates(repo([PARTS[0]!, PARTS[2]!]), 200 * GB)).toEqual([]);
    // The last part missing: what is there is numbered right, but it is not the whole model.
    expect(repoCandidates(repo([PARTS[0]!, PARTS[1]!]), 200 * GB)).toEqual([]);
    // The whole model must fit, not its largest part.
    expect(repoCandidates(repo(PARTS), 90 * GB)).toEqual([]);
    // Nothing that could point outside the store, and no deeper folders.
    expect(repoCandidates(repo([part('../evil-Q4_K_M.gguf', 1, 'a'), part('a/b/c-Q4_K_M.gguf', 1, 'a'), part('ok-Q4_K_M.gguf', 1, 'a')]), 200 * GB)
      .map((c) => c.file.rfilename)).toEqual(['ok-Q4_K_M.gguf']);
  });

  it('reads every part header, so the parameters and size are the whole model and each part is pinned', async () => {
    const hub = fakeHub();
    await discoverHuggingFaceModels(200 * GB, { wait: true }, hub.deps);
    const model = (JSON.parse(readFileSync(discoveredModelsFile(), 'utf8')) as { models: LocalModel[] }).models[0]!;
    expect(hub.headerUrls).toHaveLength(3);
    // The folder stays a folder in the URL; only the name is encoded.
    expect(hub.headerUrls[0]).toBe(`https://huggingface.co/example/big-GGUF/resolve/${SHA}/Q4_K_M/big-Q4_K_M-00001-of-00003.gguf`);
    expect(model.weights.file).toBe(PARTS[0]!.rfilename);
    expect(model.weights.sizeBytes).toBe(100 * GB);
    expect(model.quantization).toBe('Q4_K_M');
    expect(Math.round(model.totalParamsB * 1e9)).toBe(7000);
    expect(model.weightParts?.map((p) => [p.file, p.sizeBytes, p.sha256[0]])).toEqual([
      [PARTS[0]!.rfilename, 40 * GB, 'd'], [PARTS[1]!.rfilename, 40 * GB, 'e'], [PARTS[2]!.rfilename, 20 * GB, 'f'],
    ]);
    expect(weightFiles(model)).toHaveLength(3);
  });

  it('counts what is missing part by part, beside each other in the store', async () => {
    const files = PARTS.map((p) => ({ repo: 'example/big-GGUF', revision: SHA, file: p.rfilename, sizeBytes: 10 + Number(p.rfilename.at(-6)), sha256: 'a'.repeat(64) }));
    const model = { weights: { ...files[0]!, sizeBytes: 999 }, weightParts: files } as unknown as LocalModel;
    for (const file of files.slice(0, 2)) {
      const path = modelFilePath(file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.alloc(file.sizeBytes));
    }
    expect(dirname(modelFilePath(files[0]!))).toBe(dirname(modelFilePath(files[2]!)));
    expect(await missingBytes(weightFiles(model))).toBe(files[2]!.sizeBytes);
    // With the last part there too, nothing is fetched and llama.cpp is given the first part.
    mkdirSync(dirname(modelFilePath(files[2]!)), { recursive: true });
    writeFileSync(modelFilePath(files[2]!), Buffer.alloc(files[2]!.sizeBytes));
    expect(await missingBytes(weightFiles(model))).toBe(0);
    expect(await ensureModelWeights(model, () => undefined)).toBe(modelFilePath(files[0]!));
    expect(() => modelFilePath({ ...files[0]!, file: '../x.gguf' })).toThrow(/unsafe/);
    expect(hubFileUrl('a/b', SHA, 'dir/x y.gguf')).toBe(`https://huggingface.co/a/b/resolve/${SHA}/dir/x%20y.gguf`);
  });
});

describe('searching Hugging Face for what the user types', () => {
  it('looks the search up once a day, after the family refresh, without marking the cache whole or failed', async () => {
    const hub = fakeHub();
    await discoverHuggingFaceModels(200 * GB, { wait: true }, hub.deps);
    const families = hub.searches.length;
    const before = JSON.parse(readFileSync(discoveredModelsFile(), 'utf8')) as { at: number };

    hub.advance(1000);
    await discoverHuggingFaceModels(200 * GB, { wait: true, query: '  GPT-OSS   120b ' }, hub.deps);
    expect(hub.searches.slice(families)).toEqual(['gpt-oss 120b']);
    const after = JSON.parse(readFileSync(discoveredModelsFile(), 'utf8')) as { at: number; searched: Record<string, number> };
    expect(after.at).toBe(before.at);
    expect(Object.keys(after.searched)).toEqual(['gpt-oss 120b']);

    // Within a day it is not asked again; too short a search is never asked.
    await discoverHuggingFaceModels(200 * GB, { wait: true, query: 'gpt-oss 120b' }, hub.deps);
    await discoverHuggingFaceModels(200 * GB, { wait: true, query: 'gp' }, hub.deps);
    expect(hub.searches.length).toBe(families + 1);
    hub.advance(DAY);
    await discoverHuggingFaceModels(200 * GB, { refresh: 'background', wait: true, query: 'gpt-oss 120b' }, hub.deps);
    expect(hub.searches.filter((term) => term === 'gpt-oss 120b')).toHaveLength(2);
  });

  it('a search that fails is tried again and does not hold back the family refresh', async () => {
    const hub = fakeHub({ searchFails: true });
    await discoverHuggingFaceModels(200 * GB, { wait: true, query: 'deepseek' }, hub.deps);
    const cache = JSON.parse(readFileSync(discoveredModelsFile(), 'utf8')) as { searched?: Record<string, number> };
    expect(cache.searched?.deepseek).toBeUndefined();
    await discoverHuggingFaceModels(200 * GB, { wait: true, query: 'deepseek' }, hub.deps);
    expect(hub.searches.filter((term) => term === 'deepseek')).toHaveLength(2);
  });
});

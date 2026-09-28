/** Discover pinned, single-file GGUF candidates without fetching their weights.
 * Hugging Face supplies the file hash/size; @huggingface/gguf reads metadata
 * and the tensor directory with HTTP ranges. Unknown architectures are skipped
 * because their KV memory cannot yet be fitted safely. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GGMLQuantizationType, gguf } from '@huggingface/gguf';
import { allLocalModels, registerRemoteModels, type CatalogModel, type KvGeometry } from './catalog.js';
import { discoveredModelsFile } from './paths.js';

const CACHE_MS = 24 * 60 * 60 * 1000;
const SEARCHES = ['Qwen3.5-GGUF', 'Qwen3.6-GGUF', 'Gemma-4-GGUF', 'gpt-oss-GGUF', 'Ornith-GGUF'];
const QUANT = /(?:Q4_K_M|Q4_0|MXFP4|Q6_K|Q8_0)\.gguf$/i;
const LICENSES = new Set(['apache-2.0', 'mit']);
const MAX_REPOS = 12;
const MAX_HEADERS = 12;

interface HubSearch { id: string; downloads?: number }
interface HubFile { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }
interface HubModel { id: string; sha: string; gated?: boolean; private?: boolean; disabled?: boolean; cardData?: { license?: string }; siblings?: HubFile[] }

async function hubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Hugging Face returned ${response.status}`);
  return response.json() as Promise<T>;
}

function scalar(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function geometry(metadata: Record<string, unknown>): KvGeometry | undefined {
  const arch = metadata['general.architecture'];
  if (!['qwen35', 'qwen35moe', 'gemma4', 'gpt-oss'].includes(String(arch))) return undefined;
  const get = (key: string) => metadata[`${arch}.${key}`];
  const blocks = scalar(get('block_count'));
  const heads = get('attention.head_count_kv');
  const headList = Array.isArray(heads) ? heads.map(Number) : undefined;
  const kvHeads = scalar(headList?.at(-1) ?? heads);
  const keyLength = scalar(get('attention.key_length'));
  const valueLength = scalar(get('attention.value_length'));
  if (!blocks || !kvHeads || !keyLength || !valueLength) return undefined;
  if (arch === 'qwen35' || arch === 'qwen35moe') {
    const interval = scalar(get('full_attention_interval'));
    const inner = scalar(get('ssm.inner_size'));
    const state = scalar(get('ssm.state_size'));
    const groups = scalar(get('ssm.group_count'));
    if (!interval || !inner || !state || !groups) return undefined;
    const layers = Math.floor(blocks / interval);
    const linear = blocks - layers;
    const recurrentHeads = inner / state;
    return { layers, kvHeads, keyLength, valueLength,
      recurrentStateBytes: linear * (recurrentHeads * state * state * 4 + 3 * (recurrentHeads * state + 2 * groups * state) * 4) };
  }
  const window = scalar(get('attention.sliding_window'));
  if (!window) return undefined;
  if (arch === 'gpt-oss') {
    if (blocks % 2) return undefined;
    return { layers: blocks / 2, kvHeads, keyLength, valueLength,
      sliding: { layers: blocks / 2, kvHeads, keyLength, valueLength, window } };
  }
  const pattern = get('attention.sliding_window_pattern');
  if (!Array.isArray(pattern) || pattern.length !== blocks || !headList || headList.length !== blocks) return undefined;
  const slidingLayers = pattern.filter(Boolean).length;
  const fullLayers = blocks - slidingLayers;
  const slidingHeads = scalar(headList.find((_, i) => pattern[i]));
  const slidingKey = scalar(get('attention.key_length_swa'));
  const slidingValue = scalar(get('attention.value_length_swa'));
  if (!fullLayers || !slidingLayers || !slidingHeads || !slidingKey || !slidingValue) return undefined;
  return { layers: fullLayers, kvHeads, keyLength, valueLength,
    sliding: { layers: slidingLayers, kvHeads: slidingHeads, keyLength: slidingKey, valueLength: slidingValue, window } };
}

/** Bytes per block, and elements per block. Unsupported tensor types make
 * the candidate ineligible rather than letting an optimistic estimate pass. */
const TENSOR_LAYOUT = new Map<number, [number, number]>([
  [GGMLQuantizationType.F32, [4, 1]], [GGMLQuantizationType.F16, [2, 1]], [GGMLQuantizationType.BF16, [2, 1]],
  [GGMLQuantizationType.Q4_0, [18, 32]], [GGMLQuantizationType.Q4_1, [20, 32]],
  [GGMLQuantizationType.Q5_0, [22, 32]], [GGMLQuantizationType.Q5_1, [24, 32]],
  [GGMLQuantizationType.Q8_0, [34, 32]], [GGMLQuantizationType.Q8_1, [36, 32]],
  [GGMLQuantizationType.Q2_K, [84, 256]], [GGMLQuantizationType.Q3_K, [110, 256]],
  [GGMLQuantizationType.Q4_K, [144, 256]], [GGMLQuantizationType.Q5_K, [176, 256]],
  [GGMLQuantizationType.Q6_K, [210, 256]], [GGMLQuantizationType.Q8_K, [292, 256]],
  [GGMLQuantizationType.MXFP4, [17, 32]],
]);

export function remoteModelFromHeader(
  repo: HubModel, file: HubFile, header: Awaited<ReturnType<typeof gguf>>,
): CatalogModel | undefined {
  const sizeBytes = file.lfs?.size ?? file.size;
  const sha256 = file.lfs?.sha256;
  const license = repo.cardData?.license;
  const metadata = header.metadata as Record<string, unknown>;
  const kv = geometry(metadata);
  const context = scalar(metadata[`${metadata['general.architecture']}.context_length`]);
  const template = metadata['tokenizer.chat_template'];
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo.id) || !/^[\w.+-]+\.gguf$/i.test(file.rfilename)
    || !repo.sha?.match(/^[0-9a-f]{40}$/) || !sha256?.match(/^[0-9a-f]{64}$/)
    || !sizeBytes || !license || !LICENSES.has(license) || !kv || !context
    || typeof template !== 'string' || !/(?:tool|function)/i.test(template)) return undefined;
  const expertCount = scalar(metadata[`${metadata['general.architecture']}.expert_count`]);
  const expertsUsed = scalar(metadata[`${metadata['general.architecture']}.expert_used_count`]);
  if (expertCount && (!expertsUsed || expertsUsed > expertCount)) return undefined;
  const hasOutput = header.tensorInfos.some((item) => item.name === 'output.weight');
  let totalParams = 0, activeParams = 0, activeBytes = 0;
  for (const tensor of header.tensorInfos) {
    const layout = TENSOR_LAYOUT.get(tensor.dtype);
    if (!layout) return undefined;
    const elements = tensor.shape.reduce((product, n) => product * Number(n), 1);
    if (!Number.isSafeInteger(elements)) return undefined;
    const bytes = Math.ceil(elements / layout[1]) * layout[0];
    const active = tensor.name === 'token_embd.weight' && hasOutput ? 0
      : expertCount && /_exps(?:\.|_)/.test(tensor.name) ? expertsUsed! / expertCount : 1;
    totalParams += elements;
    activeParams += elements * active;
    activeBytes += bytes * active;
  }
  if (!totalParams || !activeParams) return undefined;
  const quantization = file.rfilename.match(QUANT)?.[0].replace(/\.gguf$/i, '') ?? 'unknown';
  const name = String(metadata['general.name'] ?? repo.id.split('/')[1]).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80);
  return {
    id: `hf:${repo.id}:${repo.sha.slice(0, 12)}:${file.rfilename}`, label: `${name} ${quantization}`,
    weights: { repo: repo.id, revision: repo.sha, file: file.rfilename, sizeBytes, sha256 },
    architecture: String(metadata['general.architecture']), totalParamsB: totalParams / 1e9,
    activeParamsB: activeParams / 1e9, activeWeightBytes: activeBytes, quantization,
    defaultContext: Math.min(context, 65_536), maxContext: context,
    license: license as CatalogModel['license'], kv,
    quality: 30, qualityNote: 'Hugging Face candidate; tool reliability is checked after first start', discovered: true,
  };
}

async function inspect(repo: HubModel, file: HubFile): Promise<CatalogModel | undefined> {
  const url = `https://huggingface.co/${repo.id}/resolve/${repo.sha}/${encodeURIComponent(file.rfilename)}`;
  try { return remoteModelFromHeader(repo, file, await gguf(url)); }
  catch { return undefined; }
}

/** Refresh once daily. An offline or rate-limited Hub leaves the last
 * inspected candidates available; no weight download happens here. */
export async function discoverHuggingFaceModels(maxWeightBytes: number): Promise<readonly CatalogModel[]> {
  const cache: { at?: number; maxWeightBytes?: number; models?: CatalogModel[] } = await readFile(discoveredModelsFile(), 'utf8')
    .then((text) => JSON.parse(text) as { at?: number; maxWeightBytes?: number; models?: CatalogModel[] }, () => ({}));
  if (cache.at && Date.now() - cache.at < CACHE_MS && (cache.maxWeightBytes ?? 0) >= maxWeightBytes * 0.9 && Array.isArray(cache.models)) {
    registerRemoteModels(cache.models);
    return allLocalModels();
  }
  try {
    const results = await Promise.all(SEARCHES.map(async (term) => hubJson<HubSearch[]>(
      `https://huggingface.co/api/models?filter=gguf&search=${encodeURIComponent(term)}&sort=downloads&direction=-1&limit=8`)));
    const repos = [...new Map(results.flat().map((item) => [item.id, item])).values()]
      .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0)).slice(0, MAX_REPOS);
    const details = await Promise.all(repos.map(async (item) => hubJson<HubModel>(
      `https://huggingface.co/api/models/${item.id}?blobs=true`).catch(() => undefined)));
    const candidates = details.filter((item): item is HubModel => Boolean(item && !item.gated && !item.private && !item.disabled))
      .flatMap((repo) => (repo.siblings ?? []).filter((file) => !file.rfilename.includes('/')
        && !/mmproj|projector/i.test(file.rfilename) && !/-\d{5}-of-\d{5}\.gguf$/i.test(file.rfilename)
        && QUANT.test(file.rfilename) && (file.lfs?.size ?? file.size ?? Infinity) <= maxWeightBytes)
        .map((file) => ({ repo, file })))
      .sort((a, b) => {
        const quantRank = (name: string) => /Q4_K_M/i.test(name) ? 0 : /Q4_0|MXFP4/i.test(name) ? 1 : /Q6_K/i.test(name) ? 2 : 3;
        return quantRank(a.file.rfilename) - quantRank(b.file.rfilename);
      }).slice(0, MAX_HEADERS);
    const inspected = (await Promise.all(candidates.map(({ repo, file }) => inspect(repo, file))))
      .filter((model): model is CatalogModel => Boolean(model));
    await mkdir(dirname(discoveredModelsFile()), { recursive: true });
    const merged = [...new Map([...(cache.models ?? []), ...inspected].map((model) => [model.id, model])).values()];
    await writeFile(discoveredModelsFile(), JSON.stringify({ at: Date.now(), maxWeightBytes, models: merged }));
    registerRemoteModels(merged);
  } catch { /* Network failures retain the previous candidate cache. */ }
  return allLocalModels();
}

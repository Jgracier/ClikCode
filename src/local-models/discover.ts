/** Discover pinned, single-file GGUF candidates without fetching their weights.
 * Hugging Face supplies the file hash/size; @huggingface/gguf reads metadata
 * and the tensor directory with HTTP ranges. Unknown architectures are skipped
 * because their KV memory cannot yet be fitted safely. */

import { quiet } from '../runtime/lifecycle-log.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { allLocalModels, registerRemoteModels, type CatalogModel, type KvGeometry } from './catalog.js';
import { discoveredModelsFile } from './paths.js';
import type { HardwareProfile } from './shared/index.js';

/** A refresh that found everything is good for a day. */
const CACHE_MS = 24 * 60 * 60 * 1000;
/** One that failed, or left a header unread, is tried again after this, not at every open. */
const RETRY_MS = 30 * 60 * 1000;
/** A header is read in several requests and carries the whole tokenizer (about 12 MB), so it is slow: 47 to 62 s for twelve
 * at once, measured. This only keeps a stalled connection from holding the refresh for ever. */
const HEADER_DEADLINE_MS = 150_000;
/** Candidates a header read has found ineligible, kept so they are not read again. */
const MAX_REJECTED = 300;
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

/** Bytes per block, and elements per block, by ggml tensor type id (the ids
 * are @huggingface/gguf's GGMLQuantizationType, written out so that package
 * loads only when a header is fetched; a test pins them to the enum).
 * Unsupported tensor types make the candidate ineligible rather than letting
 * an optimistic estimate pass. */
export const TENSOR_LAYOUT = new Map<number, [number, number]>([
  [0 /* F32 */, [4, 1]], [1 /* F16 */, [2, 1]], [30 /* BF16 */, [2, 1]],
  [2 /* Q4_0 */, [18, 32]], [3 /* Q4_1 */, [20, 32]],
  [6 /* Q5_0 */, [22, 32]], [7 /* Q5_1 */, [24, 32]],
  [8 /* Q8_0 */, [34, 32]], [9 /* Q8_1 */, [36, 32]],
  [10 /* Q2_K */, [84, 256]], [11 /* Q3_K */, [110, 256]],
  [12 /* Q4_K */, [144, 256]], [13 /* Q5_K */, [176, 256]],
  [14 /* Q6_K */, [210, 256]], [15 /* Q8_K */, [292, 256]],
  [39 /* MXFP4 */, [17, 32]],
]);

/** A candidate's id: its repo, its revision and its file -- all of which pin the header, so a header read once is known for good. */
export function candidateId(repo: Pick<HubModel, 'id' | 'sha'>, file: Pick<HubFile, 'rfilename'>): string {
  return `hf:${repo.id}:${repo.sha.slice(0, 12)}:${file.rfilename}`;
}

/** What the machine could hold if nothing else ran: its memory, and a dedicated card's own. Free memory is not it -- that moves
 * with whatever else is running, and a cache keyed on it was thrown away whenever memory freed up, so the slow refresh came back.
 * What does not fit right now is dropped when the list is ranked, not here. */
export function weightCapacityBytes(hardware: Pick<HardwareProfile, 'totalRamBytes' | 'gpus'>): number {
  const dedicated = hardware.gpus.filter((gpu) => !gpu.unified && !gpu.integrated).reduce((sum, gpu) => sum + gpu.vramBytes, 0);
  return hardware.totalRamBytes + dedicated;
}

export function remoteModelFromHeader(
  repo: HubModel, file: HubFile, header: Awaited<ReturnType<typeof import('@huggingface/gguf').gguf>>,
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
    id: candidateId(repo, file), label: `${name} ${quantization}`,
    weights: { repo: repo.id, revision: repo.sha, file: file.rfilename, sizeBytes, sha256 },
    architecture: String(metadata['general.architecture']), totalParamsB: totalParams / 1e9,
    activeParamsB: activeParams / 1e9, activeWeightBytes: activeBytes, quantization,
    defaultContext: Math.min(context, 65_536), maxContext: context,
    license: license as CatalogModel['license'], kv,
    quality: 30, qualityNote: 'Hugging Face candidate; tool reliability is checked after first start', discovered: true,
  };
}

type Header = Awaited<ReturnType<typeof import('@huggingface/gguf').gguf>>;
/** `rejected`: the header was read and this candidate is not eligible (final for this revision). `failed`: it could not be read. */
type Inspected = { model: CatalogModel } | { rejected: string } | { failed: true };

/** What discovery reaches the network with. Replaceable so a test can run it without one. */
export interface DiscoverDeps {
  json<T>(url: string): Promise<T>;
  header(url: string, signal: AbortSignal): Promise<Header>;
  now(): number;
}

const NETWORK: DiscoverDeps = {
  json: hubJson,
  async header(url, signal) {
    const { gguf } = await import('@huggingface/gguf');
    // One deadline over all the requests a header takes.
    return gguf(url, { fetch: (input, init) => fetch(input, { ...init, signal }) });
  },
  now: () => Date.now(),
};

async function inspect(repo: HubModel, file: HubFile, deps: DiscoverDeps): Promise<Inspected> {
  const url = `https://huggingface.co/${repo.id}/resolve/${repo.sha}/${encodeURIComponent(file.rfilename)}`;
  try {
    const model = remoteModelFromHeader(repo, file, await deps.header(url, AbortSignal.timeout(HEADER_DEADLINE_MS)));
    return model ? { model } : { rejected: candidateId(repo, file) };
  } catch { return { failed: true }; }
}

interface DiscoveryCache {
  /** When a refresh last ended well (or with some headers unread: `incomplete`). */
  at?: number;
  /** The most weight the candidates were chosen for (weightCapacityBytes). */
  maxWeightBytes?: number;
  /** A refresh that failed outright, and when. */
  failedAt?: number;
  /** Some header could not be read: try again after RETRY_MS rather than after a day. */
  incomplete?: boolean;
  models?: CatalogModel[];
  rejected?: string[];
}

async function readCache(): Promise<DiscoveryCache> {
  return readFile(discoveredModelsFile(), 'utf8').then((text) => JSON.parse(text) as DiscoveryCache, () => ({}));
}

/** Whether the cache is current: made for a machine this big, and not past its time. A failed refresh is not retried at once. */
function cacheState(cache: DiscoveryCache, capacity: number, now: number): 'fresh' | 'stale' {
  if (cache.failedAt && now - cache.failedAt < RETRY_MS) return 'fresh';
  const good = cache.at !== undefined && Array.isArray(cache.models) && (cache.maxWeightBytes ?? 0) >= capacity * 0.9;
  return good && now - cache.at! < (cache.incomplete ? RETRY_MS : CACHE_MS) ? 'fresh' : 'stale';
}

let refreshing: Promise<boolean> | undefined;

/** The discovery being refreshed now, if any: true once it ends with models the list did not have. */
export function discoveryRefresh(): Promise<boolean> | undefined { return refreshing; }

/** Look for new candidates: search the Hub, and read the header of each one not read before. Nothing is read twice -- a
 * candidate's id pins its revision -- so a refresh costs a search unless the Hub has something new. Resolves true when
 * models were added. */
async function refresh(cache: DiscoveryCache, capacity: number, deps: DiscoverDeps): Promise<boolean> {
  const known = new Map((cache.models ?? []).map((model) => [model.id, model]));
  const rejected = new Set(cache.rejected ?? []);
  try {
    const results = await Promise.all(SEARCHES.map(async (term) => deps.json<HubSearch[]>(
      `https://huggingface.co/api/models?filter=gguf&search=${encodeURIComponent(term)}&sort=downloads&direction=-1&limit=8`)));
    const repos = [...new Map(results.flat().map((item) => [item.id, item])).values()]
      .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0)).slice(0, MAX_REPOS);
    const details = await Promise.all(repos.map(async (item) => deps.json<HubModel>(
      `https://huggingface.co/api/models/${item.id}?blobs=true`).catch(quiet('local-models/discover'))));
    const candidates = details.filter((item): item is HubModel => Boolean(item && !item.gated && !item.private && !item.disabled))
      .flatMap((repo) => (repo.siblings ?? []).filter((file) => !file.rfilename.includes('/')
        && !/mmproj|projector/i.test(file.rfilename) && !/-\d{5}-of-\d{5}\.gguf$/i.test(file.rfilename)
        && QUANT.test(file.rfilename) && (file.lfs?.size ?? file.size ?? Infinity) <= capacity)
        .map((file) => ({ repo, file })))
      .sort((a, b) => {
        const quantRank = (name: string) => /Q4_K_M/i.test(name) ? 0 : /Q4_0|MXFP4/i.test(name) ? 1 : /Q6_K/i.test(name) ? 2 : 3;
        return quantRank(a.file.rfilename) - quantRank(b.file.rfilename);
      }).slice(0, MAX_HEADERS);
    const unread = candidates.filter(({ repo, file }) => repo.sha && !known.has(candidateId(repo, file)) && !rejected.has(candidateId(repo, file)));
    const read = await Promise.all(unread.map(({ repo, file }) => inspect(repo, file, deps)));
    const added = read.flatMap((item) => ('model' in item ? [item.model] : []));
    const unreadable = read.filter((item) => 'failed' in item).length;
    // Every one failing is the Hub being unreachable, not a verdict on the models.
    if (unread.length && unreadable === unread.length) throw new Error('no header could be read');
    const merged = [...new Map([...(cache.models ?? []), ...added].map((model) => [model.id, model])).values()];
    const verdicts = [...rejected, ...read.flatMap((item) => ('rejected' in item ? [item.rejected] : []))].slice(-MAX_REJECTED);
    await mkdir(dirname(discoveredModelsFile()), { recursive: true });
    const next: DiscoveryCache = { at: deps.now(), maxWeightBytes: capacity, models: merged, rejected: verdicts, ...(unreadable ? { incomplete: true } : {}) };
    await writeFile(discoveredModelsFile(), JSON.stringify(next));
    registerRemoteModels(merged);
    return added.length > 0;
  } catch (error) {
    quiet('local-models/discover')(error);
    // Offline or rate-limited: remember it, so the next open does not try again at once. What was known stays.
    try {
      await mkdir(dirname(discoveredModelsFile()), { recursive: true });
      await writeFile(discoveredModelsFile(), JSON.stringify({ ...cache, failedAt: deps.now() }));
    } catch (writeError) { quiet('local-models/discover')(writeError); }
    return false;
  }
}

/** The candidates found on Hugging Face, registered with the catalog. The ones already known are registered at once -- from
 * the cache, however old -- and a refresh that is due runs in the background: nothing here waits for the Hub, which takes
 * about a minute the first time (a header is read for each candidate). `wait` waits for it anyway.
 * `refresh: 'never'` is for a process that is about to exit, which a refresh in flight would keep alive. */
export async function discoverHuggingFaceModels(
  capacity: number, options: { wait?: boolean; refresh?: 'background' | 'never' } = {}, deps: DiscoverDeps = NETWORK,
): Promise<readonly CatalogModel[]> {
  const cache = await readCache();
  if (Array.isArray(cache.models) && cache.models.length) registerRemoteModels(cache.models);
  if (options.refresh !== 'never' && cacheState(cache, capacity, deps.now()) === 'stale') {
    refreshing ??= refresh(cache, capacity, deps).finally(() => { refreshing = undefined; });
    if (options.wait) await refreshing;
  }
  return allLocalModels();
}

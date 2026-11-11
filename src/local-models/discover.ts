/** Discover pinned GGUF candidates -- one file, or a model split into parts -- without fetching their weights.
 * Hugging Face supplies the file hash/size; @huggingface/gguf reads metadata
 * and the tensor directory with HTTP ranges. Unknown architectures are skipped
 * because their KV memory cannot yet be fitted safely. */

import { quiet } from '../runtime/lifecycle-log.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { allLocalModels, registerRemoteModels, type CatalogModel, type KvGeometry } from './catalog.js';
import { hubFileUrl, safeRepoPath, type LocalModel } from './models.js';
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
/** One part of a split model, as llama.cpp's gguf-split names it. Hugging Face caps a file at 50 GB, so large models come this way. */
const SPLIT = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
/** What the user types to search for is looked up on the Hub too, from this many characters. */
const MIN_QUERY = 3;
const LICENSES = new Set(['apache-2.0', 'mit']);
const MAX_REPOS = 12;
const MAX_HEADERS = 12;

/** A model that could be run here: one GGUF, or every part of a split one in order (`file` is then the first). */
interface Candidate { repo: HubModel; file: HubFile; parts?: HubFile[]; sizeBytes: number }

function fileBytes(file: HubFile): number { return file.lfs?.size ?? file.size ?? Infinity; }

/** The file name without a split suffix: what the quantization is read from. */
function unsplitName(name: string): string {
  const match = SPLIT.exec(name);
  return match ? `${match[1]}.gguf` : name;
}

/** A repo's candidates: each quantized single file, and each split model whose parts are all there and numbered 1..N in one folder. */
export function repoCandidates(repo: HubModel, capacity: number): Candidate[] {
  const files = (repo.siblings ?? []).filter((file) => safeRepoPath(file.rfilename) && !/mmproj|projector/i.test(file.rfilename)
    && QUANT.test(unsplitName(file.rfilename)));
  const singles: Candidate[] = files.filter((file) => !SPLIT.test(file.rfilename)).map((file) => ({ repo, file, sizeBytes: fileBytes(file) }));
  const groups = new Map<string, HubFile[]>();
  for (const file of files) {
    const match = SPLIT.exec(file.rfilename);
    if (!match) continue;
    const key = `${match[1]}|${match[3]}`;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const splits = [...groups].flatMap(([key, parts]): Candidate[] => {
    const count = Number(key.slice(key.lastIndexOf('|') + 1));
    const ordered = [...parts].sort((a, b) => Number(SPLIT.exec(a.rfilename)![2]) - Number(SPLIT.exec(b.rfilename)![2]));
    if (count < 2 || ordered.length !== count || ordered.some((part, index) => Number(SPLIT.exec(part.rfilename)![2]) !== index + 1)) return [];
    return [{ repo, file: ordered[0]!, parts: ordered, sizeBytes: ordered.reduce((sum, part) => sum + fileBytes(part), 0) }];
  });
  return [...singles, ...splits].filter((candidate) => candidate.sizeBytes <= capacity);
}

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
function candidateId(repo: Pick<HubModel, 'id' | 'sha'>, file: Pick<HubFile, 'rfilename'>): string {
  return `hf:${repo.id}:${repo.sha.slice(0, 12)}:${file.rfilename}`;
}

/** What the machine could hold if nothing else ran: its memory, and a dedicated card's own. Free memory is not it -- that moves
 * with whatever else is running, and a cache keyed on it was thrown away whenever memory freed up, so the slow refresh came back.
 * What does not fit right now is dropped when the list is ranked, not here. */
export function weightCapacityBytes(hardware: Pick<HardwareProfile, 'totalRamBytes' | 'gpus'>): number {
  const dedicated = hardware.gpus.filter((gpu) => !gpu.unified && !gpu.integrated).reduce((sum, gpu) => sum + gpu.vramBytes, 0);
  return hardware.totalRamBytes + dedicated;
}

/** A candidate from its GGUF header. A split model passes its parts and the tensors of every part (the first part's header has the
 * metadata, each part its own tensors), so the parameter count and size are the whole model's. */
export function remoteModelFromHeader(
  repo: HubModel, file: HubFile, header: Awaited<ReturnType<typeof import('@huggingface/gguf').gguf>>,
  split?: { parts: HubFile[]; tensorInfos: Awaited<ReturnType<typeof import('@huggingface/gguf').gguf>>['tensorInfos'] },
): CatalogModel | undefined {
  const files = split?.parts ?? [file];
  if (files.some((part) => !part.lfs?.sha256?.match(/^[0-9a-f]{64}$/) || !(part.lfs?.size ?? part.size))) return undefined;
  const sizeBytes = files.reduce((sum, part) => sum + (part.lfs?.size ?? part.size ?? 0), 0);
  const sha256 = file.lfs?.sha256;
  const license = repo.cardData?.license;
  const metadata = header.metadata as Record<string, unknown>;
  const kv = geometry(metadata);
  const context = scalar(metadata[`${metadata['general.architecture']}.context_length`]);
  const template = metadata['tokenizer.chat_template'];
  const splitCount = scalar(metadata['split.count']);
  if (split && splitCount !== split.parts.length) return undefined;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo.id) || !files.every((part) => safeRepoPath(part.rfilename) && /\.gguf$/i.test(part.rfilename))
    || !repo.sha?.match(/^[0-9a-f]{40}$/) || !sha256?.match(/^[0-9a-f]{64}$/)
    || !sizeBytes || !license || !LICENSES.has(license) || !kv || !context
    || typeof template !== 'string' || !/(?:tool|function)/i.test(template)) return undefined;
  const expertCount = scalar(metadata[`${metadata['general.architecture']}.expert_count`]);
  const expertsUsed = scalar(metadata[`${metadata['general.architecture']}.expert_used_count`]);
  if (expertCount && (!expertsUsed || expertsUsed > expertCount)) return undefined;
  const tensorInfos = split?.tensorInfos ?? header.tensorInfos;
  const hasOutput = tensorInfos.some((item) => item.name === 'output.weight');
  let totalParams = 0, activeParams = 0, activeBytes = 0;
  for (const tensor of tensorInfos) {
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
  const quantization = unsplitName(file.rfilename).match(QUANT)?.[0].replace(/\.gguf$/i, '') ?? 'unknown';
  const name = String(metadata['general.name'] ?? repo.id.split('/')[1]).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80);
  const model: LocalModel = {
    id: candidateId(repo, file), label: `${name} ${quantization}`,
    weights: { repo: repo.id, revision: repo.sha, file: file.rfilename, sizeBytes, sha256: sha256! },
    architecture: String(metadata['general.architecture']), totalParamsB: totalParams / 1e9,
    activeParamsB: activeParams / 1e9, activeWeightBytes: activeBytes, quantization,
    defaultContext: Math.min(context, 65_536), maxContext: context,
    license: license as CatalogModel['license'], kv,
    quality: 30, qualityNote: 'Hugging Face candidate; tool reliability is checked after first start', discovered: true,
  };
  if (split) {
    model.weightParts = split.parts.map((part) => ({
      repo: repo.id, revision: repo.sha, file: part.rfilename, sizeBytes: (part.lfs?.size ?? part.size)!, sha256: part.lfs!.sha256!,
    }));
  }
  return model;
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

async function inspect({ repo, file, parts }: Candidate, deps: DiscoverDeps): Promise<Inspected> {
  // One deadline over every header the candidate takes: a split model's later parts carry only their tensors, so they are quick.
  const signal = AbortSignal.timeout(HEADER_DEADLINE_MS);
  try {
    const headers = await Promise.all((parts ?? [file]).map((part) => deps.header(hubFileUrl(repo.id, repo.sha, part.rfilename), signal)));
    const model = remoteModelFromHeader(repo, file, headers[0]!,
      parts ? { parts, tensorInfos: headers.flatMap((header) => header.tensorInfos) } : undefined);
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
  /** Searches the user typed, and when each was last looked up on the Hub. */
  searched?: Record<string, number>;
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
/** Searches waiting or running, so the same one is not queued twice. */
const pendingQueries = new Set<string>();

/** Run one refresh after any running one, never two at once: both write the same cache file. */
function enqueue(job: () => Promise<boolean>): Promise<boolean> {
  const next: Promise<boolean> = (refreshing ?? Promise.resolve(false)).catch(() => false).then(job)
    .finally(() => { if (refreshing === next) refreshing = undefined; });
  refreshing = next;
  return next;
}

/** The discovery being refreshed now, if any: true once it ends with models the list did not have. */
export function discoveryRefresh(): Promise<boolean> | undefined { return refreshing; }

/** Look for new candidates: search the Hub, and read the header of each one not read before. Nothing is read twice -- a
 * candidate's id pins its revision -- so a refresh costs a search unless the Hub has something new. Resolves true when
 * models were added. */
async function refresh(capacity: number, deps: DiscoverDeps, query?: string): Promise<boolean> {
  // Read here, not when the refresh was queued: a search queued behind another adds to what that one wrote.
  const cache = await readCache();
  const known = new Map((cache.models ?? []).map((model) => [model.id, model]));
  const rejected = new Set(cache.rejected ?? []);
  try {
    const results = await Promise.all((query ? [query] : SEARCHES).map(async (term) => deps.json<HubSearch[]>(
      `https://huggingface.co/api/models?filter=gguf&search=${encodeURIComponent(term)}&sort=downloads&direction=-1&limit=8`)));
    const repos = [...new Map(results.flat().map((item) => [item.id, item])).values()]
      .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0)).slice(0, MAX_REPOS);
    const details = await Promise.all(repos.map(async (item) => deps.json<HubModel>(
      `https://huggingface.co/api/models/${item.id}?blobs=true`).catch(quiet('local-models/discover'))));
    const candidates = details.filter((item): item is HubModel => Boolean(item && !item.gated && !item.private && !item.disabled))
      .flatMap((repo) => repoCandidates(repo, capacity))
      .sort((a, b) => {
        const quantRank = (name: string) => /Q4_K_M/i.test(name) ? 0 : /Q4_0|MXFP4/i.test(name) ? 1 : /Q6_K/i.test(name) ? 2 : 3;
        return quantRank(unsplitName(a.file.rfilename)) - quantRank(unsplitName(b.file.rfilename));
      }).slice(0, MAX_HEADERS);
    const unread = candidates.filter(({ repo, file }) => repo.sha && !known.has(candidateId(repo, file)) && !rejected.has(candidateId(repo, file)));
    const read = await Promise.all(unread.map((candidate) => inspect(candidate, deps)));
    const added = read.flatMap((item) => ('model' in item ? [item.model] : []));
    const unreadable = read.filter((item) => 'failed' in item).length;
    // Every one failing is the Hub being unreachable, not a verdict on the models.
    if (unread.length && unreadable === unread.length) throw new Error('no header could be read');
    const merged = [...new Map([...(cache.models ?? []), ...added].map((model) => [model.id, model])).values()];
    const verdicts = [...rejected, ...read.flatMap((item) => ('rejected' in item ? [item.rejected] : []))].slice(-MAX_REJECTED);
    await mkdir(dirname(discoveredModelsFile()), { recursive: true });
    // A typed search adds what it found and notes the search; only the family refresh says when the cache was last made whole.
    const next: DiscoveryCache = query
      ? { ...cache, models: merged, rejected: verdicts, searched: { ...cache.searched, [query]: deps.now() } }
      : { ...cache, at: deps.now(), maxWeightBytes: capacity, models: merged, rejected: verdicts, failedAt: undefined, incomplete: unreadable ? true : undefined };
    await writeFile(discoveredModelsFile(), JSON.stringify(next));
    registerRemoteModels(merged);
    return added.length > 0;
  } catch (error) {
    quiet('local-models/discover')(error);
    // A typed search that failed is only not noted, so it is tried again; it does not hold back the family refresh.
    if (query) return false;
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
  capacity: number, options: { wait?: boolean; refresh?: 'background' | 'never'; query?: string } = {}, deps: DiscoverDeps = NETWORK,
): Promise<readonly CatalogModel[]> {
  const cache = await readCache();
  if (Array.isArray(cache.models) && cache.models.length) registerRemoteModels(cache.models);
  if (options.refresh !== 'never') {
    if (!refreshing && cacheState(cache, capacity, deps.now()) === 'stale') enqueue(() => refresh(capacity, deps));
    // What the user typed is looked up too, once a day per search, after the family refresh.
    const query = options.query?.trim().toLowerCase().replace(/\s+/g, ' ');
    if (query && query.length >= MIN_QUERY && !pendingQueries.has(query) && deps.now() - (cache.searched?.[query] ?? 0) >= CACHE_MS) {
      pendingQueries.add(query);
      enqueue(() => refresh(capacity, deps, query).finally(() => pendingQueries.delete(query)));
    }
    if (options.wait && refreshing) await refreshing;
  }
  return allLocalModels();
}

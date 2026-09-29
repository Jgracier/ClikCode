/** Which catalog model to run on this machine, and how: whether it fits,
 * how fast it should be, and in what order to offer them.
 *
 * Everything here is pure -- hardware and budget in, a decision out -- so
 * every rule is unit-tested. Estimates only order the models; once a model
 * has run here, its measurements replace the estimates: its speed, and
 * the memory it really held (see measuredNeed). */

import type { MemoryBudget } from './budget.js';
import type { CatalogModel, KvGeometry } from './catalog.js';
import type { GpuInfo, HardwareProfile } from './hardware.js';

const GIB = 1024 ** 3;

/** What "usable as a coding agent" means for a local model. The agent's
 * opening prompt (instructions plus every tool definition) runs to many
 * thousands of tokens; at 50 a second that is a few minutes, once, since
 * llama.cpp reuses the cached prefix after. 8 tokens a second writes a
 * paragraph in a few seconds. */
export const MIN_PROMPT_PER_SECOND = 50;
export const MIN_GENERATE_PER_SECOND = 8;

// ---- memory ----------------------------------------------------------------

export type CacheType = 'f16' | 'q8_0';

/** Bytes per element: q8_0 packs 32 values into 34 bytes. q4_0 is never
 * used: on a CPU it halved prompt reading once context built up (36.8 vs
 * 69.5 tokens/s at 8K deep, 8-core Zen 4), to save memory f16 or q8_0
 * could spare. */
const CACHE_ELEMENT_BYTES: Record<CacheType, number> = { f16: 2, q8_0: 34 / 32 };

/** Context checkpoints llama.cpp keeps per slot for recurrent models,
 * one per 8K tokens of context (--checkpoint-min-step), at most 32. */
function checkpoints(context: number): number {
  return Math.min(32, Math.floor(context / 8192));
}

/** KV cache plus recurrent state for `context` tokens over `parallel`
 * slots. The KV pool is unified (shared by the slots, sized by context);
 * sliding-window layers and recurrent state are per slot. */
export function kvCacheBytes(kv: KvGeometry, context: number, cacheType: CacheType, parallel: number): number {
  const element = CACHE_ELEMENT_BYTES[cacheType];
  const full = kv.layers * kv.kvHeads * (kv.keyLength + kv.valueLength) * element * context;
  const sliding = kv.sliding
    ? kv.sliding.layers * kv.sliding.kvHeads * (kv.sliding.keyLength + kv.sliding.valueLength) * element
      * Math.min(context, (kv.sliding.window + 512) * parallel)
    : 0;
  const recurrent = (kv.recurrentStateBytes ?? 0) * parallel * (1 + checkpoints(context));
  return full + sliding + recurrent;
}

/** llama.cpp's working buffers beyond weights and cache: the compute graph
 * (dominated by the logits of a ~250K-token vocabulary over a 512-token
 * batch, about 0.5 GB) and the server's own state. */
export function runtimeOverheadBytes(weightBytes: number): number {
  return 0.75 * GIB + weightBytes * 0.02;
}

/** The KV cache type on a GPU: f16 when at least 16 GiB of budget stays
 * free beyond the weights (it cost 4.7 GB more than q4_0 at 64K for a
 * 35B-A3B), else q8_0, which costs about half as much. Not for the CPU:
 * there q8_0 read prompts 4.5x slower 16K deep (Qwen3.5 4B 65.3 -> 14.5
 * tokens/s, gpt-oss 46.9 -> 14.4, 8-core Zen 4), so the CPU fit takes f16
 * at any context before q8_0 at all (fitModel). */
export function chooseCacheType(budgetBytes: number, weightBytes: number): CacheType {
  return budgetBytes - weightBytes >= 16 * GIB ? 'f16' : 'q8_0';
}

export type Placement = 'cpu' | 'gpu' | 'gpu-partial';

export interface FitOptions {
  /** Explicit context: tried as given, not shrunk. */
  context?: number;
  vision?: boolean;
  parallel?: number;
  /** What this model really held on this machine in earlier runs. */
  footprints?: readonly Footprint[];
}

/** A model's peak resident memory in one configuration, as the supervisor
 * measured it: RssAnon (its allocations: weights read into memory, the KV
 * cache, the prompt cache, buffers) plus, for a server that maps its
 * weights, RssFile (the mapped weights). */
export interface Footprint {
  context: number;
  cacheType: string;
  parallel: number;
  vision: boolean;
  anonBytes: number;
  fileBytes: number;
  /** Whether the weights were mapped. Records without it predate reading
   * weights into memory on the CPU and are ignored there (see measuredNeed). */
  mmap?: boolean;
  at: string;
}

export interface Fit {
  fits: boolean;
  /** Why not, in a phrase fit to show beside the model. */
  reason?: string;
  placement: Placement;
  context: number;
  cacheType: CacheType;
  weightBytes: number;
  /** Everything the server will hold: weights, cache, buffers. */
  needBytes: number;
  /** needBytes comes from a measured footprint, not the estimate. */
  measured?: boolean;
  /** The part of needBytes on the GPU (0 on a CPU). */
  gpuBytes: number;
  parallel: number;
}

/** Smallest context worth running an agent with: its opening prompt alone
 * is several thousand tokens. */
export const MIN_CONTEXT = 16_384;

/** Memory set aside for llama.cpp's prompt cache before a context beyond
 * the model's default is granted: a longer context is a nice-to-have, and
 * the prompt cache (which saves re-reading a session's prompt when two
 * sessions take turns) is worth more than it. Matches the 2 GiB cap on
 * --cache-ram the engine starts servers with. */
export const PROMPT_CACHE_ALLOWANCE = 2 * GIB;

/** Largest first: the model's maximum context, halved down to MIN_CONTEXT,
 * with its default among them. An explicit context is tried as given. */
export function contextsToTry(model: Pick<CatalogModel, 'defaultContext' | 'maxContext'>, requested?: number): number[] {
  if (requested) return [Math.min(requested, model.maxContext)];
  const list = new Set<number>();
  for (let context = model.maxContext; context >= MIN_CONTEXT; context = Math.floor(context / 2)) list.add(context);
  if (model.defaultContext >= MIN_CONTEXT && model.defaultContext <= model.maxContext) list.add(model.defaultContext);
  if (!list.size) list.add(Math.min(model.defaultContext, model.maxContext));
  return [...list].sort((left, right) => right - left);
}

/** What the model needs at this context and cache type, from the nearest
 * measured run: that run's peak, adjusted by the estimated difference in
 * KV cache (and projector, for vision) between the two configurations. The
 * measured part carries everything the estimate gets wrong -- repacked
 * weights held twice, compute buffers, a prompt cache that filled -- and
 * the adjustment is the one part the estimate gets right, since the KV
 * cache's size follows from the model's geometry. Undefined before the
 * first run. A run at the same parallelism is required: a different slot
 * count changes buffers the adjustment does not model.
 *
 * Only runs that read the weights into memory count (this is the CPU fit,
 * and CPU servers do that; see usesMmap). A run that mapped them on the CPU
 * counted repacked tensors twice, once in its own memory and once as
 * mapped file, so its footprint overstates what the model needs. */
export function measuredNeed(
  model: CatalogModel, footprints: readonly Footprint[] | undefined, context: number, cacheType: CacheType, parallel: number, vision: boolean,
): number | undefined {
  const candidates = (footprints ?? []).filter((item) => item.mmap === false && item.parallel === parallel && item.anonBytes > 0 && item.context > 0);
  if (!candidates.length) return undefined;
  const distance = (item: Footprint): number => (item.cacheType === cacheType ? 0 : 100) + (item.vision === vision ? 0 : 10)
    + Math.abs(Math.log2(context / item.context));
  const nearest = candidates.reduce((best, item) => (distance(item) < distance(best) ? item : best));
  const projector = model.projector?.sizeBytes ?? 0;
  const itemType: CacheType = nearest.cacheType === 'q8_0' ? 'q8_0' : 'f16';
  return nearest.anonBytes + nearest.fileBytes
    + kvCacheBytes(model.kv, context, cacheType, parallel) - kvCacheBytes(model.kv, nearest.context, itemType, parallel)
    + (Number(vision) - Number(nearest.vision)) * projector;
}

/** Whether a model fits the budget, where, and at what context: the
 * largest context that fits, from the model's maximum down to MIN_CONTEXT;
 * one beyond the model's default also has to leave the prompt cache its
 * room. On the CPU the need is the measured footprint once there is one,
 * so a model that turned out bigger (or smaller) than estimated is fitted
 * by what it really took. On a
 * discrete GPU the whole model goes on the card when it fits there; failing
 * that, as many layers as fit (llama.cpp's --fit places them) with the rest
 * in RAM, provided the card takes a useful share. */
export function fitModel(model: CatalogModel, budget: MemoryBudget, options: FitOptions = {}): Fit {
  const parallel = options.parallel ?? (budget.gpu && !budget.gpu.unified ? 4 : 2);
  const weightBytes = model.weights.sizeBytes + (options.vision && model.projector ? model.projector.sizeBytes : 0);
  const overhead = runtimeOverheadBytes(weightBytes);
  const vision = Boolean(options.vision && model.projector);
  // Past the default a context is extra, so it must also leave the prompt
  // cache its room; an explicit context is the caller's call.
  const extra = (context: number): boolean => !options.context && context > model.defaultContext;
  const allowance = (context: number): number => (extra(context) ? PROMPT_CACHE_ALLOWANCE : 0);
  let smallest: Fit | undefined;
  // On the CPU, f16 at a smaller context beats q8_0 at a larger one; q8_0
  // only when f16 fits nowhere (chooseCacheType).
  const cpuCacheTypes: CacheType[] = ['f16', 'q8_0'];
  for (const cpuCacheType of cpuCacheTypes) for (const context of contextsToTry(model, options.context)) {
    const gpu = budget.gpu;
    if (gpu?.unified) {
      // Apple Silicon or integrated graphics: the GPU works from RAM, so its
      // budget is the only one.
      const cacheType = chooseCacheType(gpu.bytes, weightBytes);
      const needBytes = weightBytes + kvCacheBytes(model.kv, context, cacheType, parallel) + overhead;
      const fit: Fit = { fits: needBytes + allowance(context) <= gpu.bytes, placement: 'gpu', context, cacheType, weightBytes, needBytes, gpuBytes: needBytes, parallel };
      if (fit.fits) return fit;
      smallest = fit;
      continue;
    }
    if (gpu && gpu.bytes > 0) {
      const cacheType = chooseCacheType(gpu.bytes, weightBytes);
      const needBytes = weightBytes + kvCacheBytes(model.kv, context, cacheType, parallel) + overhead;
      if (needBytes <= gpu.bytes) {
        return { fits: true, placement: 'gpu', context, cacheType, weightBytes, needBytes, gpuBytes: needBytes, parallel };
      }
      // A context beyond the default is taken only whole on the card: bought
      // with layers moved to the CPU, or with a CPU-only run, it would cost
      // speed on every token for room most turns never use.
      if (extra(context)) continue;
      // Partial offload only when the card holds at least a quarter of the
      // model: below that the PCIe traffic eats what the GPU adds.
      if (gpu.bytes >= needBytes * 0.25 && needBytes - gpu.bytes <= budget.ramBytes) {
        return { fits: true, placement: 'gpu-partial', context, cacheType, weightBytes, needBytes, gpuBytes: gpu.bytes, parallel };
      }
    }
    const cacheType = cpuCacheType;
    const measured = measuredNeed(model, options.footprints, context, cacheType, parallel, vision);
    const needBytes = measured ?? weightBytes + kvCacheBytes(model.kv, context, cacheType, parallel) + overhead;
    const fit: Fit = {
      fits: needBytes + allowance(context) <= budget.ramBytes, placement: 'cpu', context, cacheType, weightBytes, needBytes, gpuBytes: 0, parallel,
      ...(measured !== undefined ? { measured: true } : {}),
    };
    if (fit.fits) return fit;
    // The last (smallest) context tried is what the reason quotes.
    smallest = fit;
  }
  const where = budget.gpu?.unified ? 'unified memory' : 'RAM';
  const room = budget.gpu?.unified ? budget.gpu.bytes : budget.ramBytes;
  return {
    ...smallest!,
    fits: false,
    reason: `needs ${gb(smallest!.needBytes)} at ${Math.round(smallest!.context / 1024)}K context; ${gb(room)} of ${where} is free for models`,
  };
}

/** Decimal GB, the unit download sizes are shown in. */
function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

// ---- speed -----------------------------------------------------------------

/** Prompt tokens a second per billion active parameters on 8 cores, by
 * quantization, measured with llama-bench on an 8-core Zen 4 (Ryzen 7
 * 8745HS, AVX-512): Q4_K 264, Q3_K 136, IQ3_XXS 79. The kernels set this,
 * not the file size -- IQ3_XXS is the smaller file and the slower read.
 * Q4_0 and MXFP4 use the Q4_K figure (similar kernels, unmeasured);
 * others take a middling value. */
const CPU_PROMPT_RATE: readonly [RegExp, number][] = [
  [/IQ[1-3]/i, 79], [/Q3_K/i, 136], [/Q[45]_K|Q4_0|Q4_1|MXFP4/i, 264], [/Q[68]/i, 200], [/BF16|F16/i, 60],
];

/** Weight bandwidth llama.cpp reached generating on that machine: writing
 * speed times bytes read per token, about 40 GB/s (a STREAM test shows
 * 46-55; the rest is overhead). Dual-channel DDR5 is the common desktop
 * and laptop case; it is only a starting point until measured. */
const CPU_WEIGHT_BANDWIDTH = 40e9;

/** Apple Silicon memory bandwidth by tier (base / Pro / Max / Ultra), at
 * the ~75% llama.cpp achieves on it. */
function appleBandwidth(cpuModel: string): number {
  const peak = /ultra/i.test(cpuModel) ? 800e9 : /max/i.test(cpuModel) ? 400e9 : /pro/i.test(cpuModel) ? 200e9 : 100e9;
  return peak * 0.75;
}

export interface SpeedEstimate { promptPerSecond: number; generatePerSecond: number }

export function cpuPromptRate(quantization: string): number {
  return CPU_PROMPT_RATE.find(([pattern]) => pattern.test(quantization))?.[1] ?? 150;
}

/** Bytes a token reads: the whole file for a dense model, the active
 * share for a mixture of experts. */
function bytesPerToken(model: CatalogModel): number {
  return model.activeWeightBytes ?? model.weights.sizeBytes * Math.min(1, model.activeParamsB / model.totalParamsB);
}

/** Estimate the same 2,000-input/300-output turn used in the local benchmarks
 * at the 80% context depth where conversation compaction begins. The depth
 * terms were fitted on seven GGUF builds on an eight-core Zen 4, then checked
 * on four held-out deep runs. A first-run speed measurement calibrates the
 * shallow part on the actual machine; the depth term remains an estimate. */
export function speedAtContext(
  model: CatalogModel, hardware: Pick<HardwareProfile, 'physicalCores' | 'cpuModel'>,
  fit: Fit, measured?: Measurement, gpu?: Pick<GpuInfo, 'backend' | 'integrated'>,
): SpeedEstimate {
  const shallow = estimateSpeed(model, hardware, fit, gpu);
  const base = measured?.promptPerSecond && measured.generatePerSecond
    ? { promptPerSecond: measured.promptPerSecond, generatePerSecond: measured.generatePerSecond } : shallow;
  if (fit.placement !== 'cpu') return base; // GPU depth coefficients await GPU measurements.
  const depth = Math.floor(fit.context * 0.8);
  const fullKvWork = model.kv.layers * model.kv.kvHeads * model.kv.keyLength;
  const headRatio = model.architecture === 'gemma4' || model.architecture === 'gpt-oss' ? 8 : 4;
  const fullQWork = fullKvWork * headRatio;
  const cores = Math.max(1, Math.min(8, hardware.physicalCores));
  const effectiveCores = cores * (1 - 0.3267 * (cores - 1) / 7);
  const promptExtraSeconds = 0.49697 * (fullQWork / 10_000) * (depth / 1_000_000) / effectiveCores;
  const generateExtraSeconds = 0.056167 * (fullKvWork / 10_000) * (depth ** 1.5 / 1_000_000)
    * (8 / cores);
  return {
    promptPerSecond: 1 / (1 / base.promptPerSecond + promptExtraSeconds),
    generatePerSecond: 1 / (1 / base.generatePerSecond + generateExtraSeconds),
  };
}

export function estimatedTurnSeconds(speed: SpeedEstimate): number {
  return 2_000 / speed.promptPerSecond + 300 / speed.generatePerSecond;
}

/** A newly loaded model must read the agent's instructions and tool schemas
 * before it can answer. The lower end is a brief answer; the upper end also
 * covers a long answer or reasoning tokens. These are inference times after
 * the server is ready, not a promise about model loading or downloading. */
export function firstReplySeconds(speed: SpeedEstimate): { brief: number; long: number } {
  const promptSeconds = 4_000 / speed.promptPerSecond;
  return {
    brief: promptSeconds + 300 / speed.generatePerSecond,
    long: promptSeconds + 1_000 / speed.generatePerSecond,
  };
}

/** A context is useful when it fits memory and can still complete a typical
 * deep turn near the established 50-read/8-write budget (77.5 seconds). */
const MAX_DEEP_TURN_SECONDS = 2_000 / MIN_PROMPT_PER_SECOND + 300 / MIN_GENERATE_PER_SECOND;
/** A first agent reply that may use up to 1,000 output tokens should still
 * arrive promptly after the model has loaded. */
const MAX_FIRST_REPLY_SECONDS = 90;
/** The worst held-out deep turn was 14.4% slower than predicted. Do not
 * advertise a model as meeting the target at that edge. */
const DEEP_TIME_MARGIN = 1.15;

function fitForConversation(
  model: CatalogModel, hardware: Pick<HardwareProfile, 'physicalCores' | 'cpuModel'>,
  budget: MemoryBudget, measured: Measurement | undefined, footprints: readonly Footprint[],
): Fit {
  const memoryFit = fitModel(model, budget, { footprints });
  if (!memoryFit.fits || memoryFit.placement !== 'cpu') return memoryFit;
  let smallest = memoryFit;
  let workingWindow: Fit | undefined;
  // A 16K window compacts a coding task after ~13K tokens. On Ornith the
  // repeated compaction made seven-task runs slower despite faster tokens:
  // 32K kept the same 6/7 pass rate and cut total time ~13%. Do not trade
  // that working room away merely to improve a single deep-token estimate.
  const workingMinimum = Math.min(32_768, model.maxContext);
  for (const context of contextsToTry(model)) {
    const fit = fitModel(model, budget, { context, footprints });
    if (!fit.fits || fit.placement !== 'cpu') continue;
    // fitModel prefers f16 across *all* contexts before considering q8_0.
    // Its explicit-context call can fall back to q8_0 at a larger window;
    // never undo that global choice while tuning context for speed.
    if (fit.cacheType !== memoryFit.cacheType) continue;
    const room = budget.ramBytes - fit.needBytes;
    if (context > model.defaultContext && room < PROMPT_CACHE_ALLOWANCE) continue;
    smallest = fit;
    if (context >= workingMinimum) workingWindow = fit;
    const speed = speedAtContext(model, hardware, fit, measured, budget.gpu?.devices[0]);
    if (estimatedTurnSeconds(speed) * DEEP_TIME_MARGIN <= MAX_DEEP_TURN_SECONDS
      && (context >= workingMinimum || !workingWindow)) return fit;
  }
  return workingWindow ?? smallest;
}

export function estimateSpeed(model: CatalogModel, hardware: Pick<HardwareProfile, 'physicalCores' | 'cpuModel'>, fit: Pick<Fit, 'placement' | 'gpuBytes' | 'needBytes'>, gpuDevice?: Pick<GpuInfo, 'backend' | 'integrated'>): SpeedEstimate {
  const active = Math.max(0.1, model.activeParamsB);
  const cpu: SpeedEstimate = {
    promptPerSecond: (cpuPromptRate(model.quantization) * hardware.physicalCores / 8) / active,
    generatePerSecond: CPU_WEIGHT_BANDWIDTH / Math.max(1, bytesPerToken(model)),
  };
  if (fit.placement === 'cpu') return cpu;
  // GPU figures are rough orders of magnitude -- a mid-range card, or the
  // Apple tier -- and exist to rank a GPU run above a CPU one; the
  // measurement after the first start is what gets shown. Integrated x86
  // graphics are measured: a Radeon 780M on b11194 Vulkan generated at an
  // effective 55-61 GB/s (Ornith 35B-A3B 27.5 tokens/s, Qwen3.5-4B 22) and
  // read 1,300-1,940 tokens/s per billion active parameters; the lower of
  // each, so a big dense model is not ranked above what the chip delivers.
  const gpuBackend = gpuDevice?.backend;
  const integratedX86 = Boolean(gpuDevice?.integrated) && gpuBackend !== 'metal';
  const bandwidth = gpuBackend === 'metal' ? appleBandwidth(hardware.cpuModel) : integratedX86 ? 55e9 : 300e9;
  const gpu: SpeedEstimate = {
    promptPerSecond: (gpuBackend === 'metal' ? bandwidth / 75e9 * 1600 : integratedX86 ? 1_300 : 20_000) / active,
    generatePerSecond: bandwidth / Math.max(1, bytesPerToken(model)),
  };
  if (fit.placement === 'gpu') return gpu;
  // Partly offloaded: each token spends time on both sides in proportion.
  const share = Math.min(1, fit.gpuBytes / fit.needBytes);
  const blend = (onGpu: number, onCpu: number): number => 1 / (share / onGpu + (1 - share) / onCpu);
  return { promptPerSecond: blend(gpu.promptPerSecond, cpu.promptPerSecond), generatePerSecond: blend(gpu.generatePerSecond, cpu.generatePerSecond) };
}

// ---- measurement and ranking ----------------------------------------------

export interface Measurement {
  promptPerSecond?: number;
  generatePerSecond?: number;
  toolCalls: boolean;
  at: string;
}

export function meetsBar(speed: { promptPerSecond?: number; generatePerSecond?: number; toolCalls?: boolean }): boolean {
  return speed.toolCalls !== false
    && (speed.promptPerSecond ?? 0) >= MIN_PROMPT_PER_SECOND && (speed.generatePerSecond ?? 0) >= MIN_GENERATE_PER_SECOND;
}

export interface RankedModel {
  model: CatalogModel;
  fit: Fit;
  estimate: SpeedEstimate;
  measured?: Measurement;
  /** The measurement when there is one, else the estimate. */
  speed: SpeedEstimate;
  /** Inference time of the first reply after loading, at shallow context. */
  firstReply: ReturnType<typeof firstReplySeconds>;
  passes: boolean;
}

/** Every catalog model in the order it should be offered: models that fit
 * and meet both response targets, best quality first; then models within
 * 15% of the quickest fitting tool-capable model, best quality first. A
 * difference smaller than the CPU equation's held-out error cannot justify
 * sacrificing coding quality. Clearly slower, tool-incapable, and unfit
 * models follow in that order. A
 * measurement stands in for the estimate wherever there is one. */
export function rankModels(
  catalog: readonly CatalogModel[], hardware: Pick<HardwareProfile, 'physicalCores' | 'cpuModel'>, budget: MemoryBudget,
  measurements: Readonly<Record<string, Measurement>>, footprints: Readonly<Record<string, readonly Footprint[]>> = {},
): RankedModel[] {
  const ranked = catalog.map((model): RankedModel => {
    const measured = measurements[model.id];
    const fit = fitForConversation(model, hardware, budget, measured, footprints[model.id] ?? []);
    const estimate = speedAtContext(model, hardware, fit, undefined, budget.gpu?.devices[0]);
    const speed = speedAtContext(model, hardware, fit, measured, budget.gpu?.devices[0]);
    const shallow = measured?.promptPerSecond && measured.generatePerSecond
      ? { promptPerSecond: measured.promptPerSecond, generatePerSecond: measured.generatePerSecond }
      : estimateSpeed(model, hardware, fit, budget.gpu?.devices[0]);
    const firstReply = firstReplySeconds(shallow);
    return {
      model, fit, estimate, speed, firstReply,
      passes: fit.fits && measured?.toolCalls !== false && estimatedTurnSeconds(speed) * DEEP_TIME_MARGIN <= MAX_DEEP_TURN_SECONDS
        && firstReply.long <= MAX_FIRST_REPLY_SECONDS,
      ...(measured ? { measured } : {}),
    };
  });
  const responseCost = (row: RankedModel): number => Math.max(
    row.firstReply.long / MAX_FIRST_REPLY_SECONDS,
    estimatedTurnSeconds(row.speed) * DEEP_TIME_MARGIN / MAX_DEEP_TURN_SECONDS,
  );
  const viable = ranked.filter((row) => row.fit.fits && row.measured?.toolCalls !== false);
  const quickestFirst = Math.min(...viable.map((row) => row.firstReply.long));
  const quickestDeep = Math.min(...viable.map((row) => estimatedTurnSeconds(row.speed)));
  const group = (row: RankedModel): number => row.passes ? 0
    : !row.fit.fits ? 4
      : row.measured?.toolCalls === false ? 3
        : row.firstReply.long <= quickestFirst * 1.15
          && estimatedTurnSeconds(row.speed) <= quickestDeep * 1.15 ? 1 : 2;
  return ranked.sort((left, right) => group(left) - group(right)
    || (group(left) <= 1 ? right.model.quality - left.model.quality
      : group(left) <= 3 ? responseCost(left) - responseCost(right)
        : left.fit.needBytes - right.fit.needBytes));
}

export interface Choice { row: RankedModel; notice?: string }

/** The model to run. The user's explicit pick always wins over the
 * ranking -- a slow model they chose is their call -- but never over the
 * budget. With no pick: the best model that meets the bar, or, when none
 * does, the best quality near the quickest, with a notice saying so. */
export function chooseModel(ranked: readonly RankedModel[], pick?: string): Choice {
  if (pick) {
    const row = ranked.find((item) => item.model.id === pick);
    if (!row) throw new Error(`${pick} is not a ClikCode Local model.`);
    if (!row.fit.fits) throw new Error(`${row.model.label} does not fit on this machine: ${row.fit.reason}.`);
    return {
      row,
      ...(!row.passes ? { notice: row.measured?.toolCalls === false
        ? `${row.model.label} did not make a tool call in its local check, so coding-agent tasks may fail.`
        : `${row.model.label} may take about ${Math.round(row.firstReply.brief)}–${Math.round(row.firstReply.long)} seconds for its first reply after loading; longer replies take longer.` } : {}),
    };
  }
  const [best] = ranked;
  if (!best || !best.fit.fits) throw new Error('No ClikCode Local model fits in the memory this machine has free.');
  if (best.passes) return { row: best };
  return {
    row: best,
    notice: `No local model is estimated to meet both response-speed targets here; `
      + `${best.model.label} is the highest-ranked coding model near the quickest that fits `
      + `(about ${Math.round(best.firstReply.brief)}–${Math.round(best.firstReply.long)} seconds for its first reply after loading).`,
  };
}

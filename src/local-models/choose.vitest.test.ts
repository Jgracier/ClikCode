import { describe, expect, it } from 'vitest';
import { memoryBudget, memoryBuffer, startMargin, vramReserve } from './budget';
import { LOCAL_MODEL_CATALOG, catalogModel, type CatalogModel } from './catalog';
import {
  chooseCacheType, chooseModel, contextsToTry, estimateSpeed, fitModel, kvCacheBytes, measuredNeed, meetsBar, rankModels, MIN_CONTEXT,
  PROMPT_CACHE_ALLOWANCE, type Footprint,
} from './choose';
import type { HardwareProfile } from './hardware';
import { buildServerArgs, threadPlan, usesMmap } from './launch';
import { selectRuntimeBuild } from './runtime';

const GIB = 1024 ** 3;

/** The machine the speed constants were measured on. */
const ZEN4: HardwareProfile = {
  platform: 'linux', arch: 'x64', cpuModel: 'AMD Ryzen 7 8745HS w/ Radeon 780M Graphics',
  physicalCores: 8, logicalCores: 16, totalRamBytes: 57.6 * GIB, availableRamBytes: 40 * GIB,
  gpus: [{ name: 'Radeon 780M Graphics', vendor: 'amd', backend: 'vulkan', vramBytes: 4 * GIB, unified: true, integrated: true }],
  vulkanLoader: true,
};

function model(id: string): CatalogModel {
  const found = catalogModel(id);
  if (!found) throw new Error(id);
  return found;
}

describe('catalog', () => {
  it('pins every file to a commit, a size and a sha256', () => {
    for (const entry of LOCAL_MODEL_CATALOG) {
      for (const file of [entry.weights, ...(entry.projector ? [entry.projector] : [])]) {
        expect(file.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.sizeBytes).toBeGreaterThan(100e6);
        expect(Number.isInteger(file.sizeBytes)).toBe(true);
        // The downloader fetches one file; a split GGUF's first shard alone
        // would download, verify and then fail to load.
        expect(file.file).toMatch(/\.gguf$/);
        expect(file.file).not.toMatch(/-\d{5}-of-\d{5}\.gguf$/);
      }
      expect(['apache-2.0', 'mit']).toContain(entry.license);
      expect(entry.activeParamsB).toBeGreaterThan(0);
      expect(entry.activeParamsB).toBeLessThanOrEqual(entry.totalParamsB);
      expect(entry.defaultContext).toBeGreaterThanOrEqual(MIN_CONTEXT);
      expect(entry.defaultContext).toBeLessThanOrEqual(entry.maxContext);
      expect(entry.quality).toBeGreaterThan(0);
      expect(entry.quality).toBeLessThanOrEqual(100);
      expect(entry.weights.file).toContain(entry.quantization);
    }
  });

  it('names every model once, by id and by label', () => {
    const ids = LOCAL_MODEL_CATALOG.map((entry) => entry.id.toLowerCase());
    const labels = LOCAL_MODEL_CATALOG.map((entry) => entry.label.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
    // resolveLocalModelId matches either, so one model's label must not be
    // another's id.
    expect(ids.filter((id) => labels.includes(id))).toEqual([]);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
  });

  it('has file sizes that match the parameters and quantization', () => {
    // Bits per weight a whole GGUF lands at: embeddings and norms are kept
    // wider than the bulk, so each sits a little above the nominal width.
    const bitsPerWeight: [RegExp, number, number][] = [
      [/^(Q4_K_M|Q4_0|MXFP4)$/, 4.3, 5.8], [/^Q6_K$/, 6.4, 7.0], [/^Q8_0$/, 8.4, 8.8],
    ];
    for (const entry of LOCAL_MODEL_CATALOG) {
      const range = bitsPerWeight.find(([pattern]) => pattern.test(entry.quantization));
      expect(range, entry.id).toBeDefined();
      const bits = entry.weights.sizeBytes * 8 / (entry.totalParamsB * 1e9);
      expect(bits, entry.id).toBeGreaterThanOrEqual(range![1]);
      expect(bits, entry.id).toBeLessThanOrEqual(range![2]);
    }
  });

  it('ranks a higher-precision build above its own Q4 but never above a stronger model', () => {
    const sameModel = (left: CatalogModel, right: CatalogModel): boolean => left.weights.repo === right.weights.repo
      && left.totalParamsB === right.totalParamsB && left.architecture === right.architecture;
    for (const entry of LOCAL_MODEL_CATALOG) {
      for (const other of LOCAL_MODEL_CATALOG) {
        if (entry === other || !sameModel(entry, other)) continue;
        expect(entry.kv).toEqual(other.kv);
        expect(entry.license).toBe(other.license);
        if (entry.weights.sizeBytes > other.weights.sizeBytes) expect(entry.quality, entry.id).toBeGreaterThan(other.quality);
      }
    }
    for (const entry of LOCAL_MODEL_CATALOG) {
      const base = LOCAL_MODEL_CATALOG.find((other) => other !== entry && sameModel(entry, other) && other.quantization === 'Q4_K_M');
      if (!base) continue;
      const stronger = LOCAL_MODEL_CATALOG.filter((other) => !sameModel(other, entry) && other.quality > base.quality);
      for (const other of stronger) expect(entry.quality, `${entry.id} vs ${other.id}`).toBeLessThan(other.quality);
    }
  });

  it('covers the size tiers', () => {
    const sizes = LOCAL_MODEL_CATALOG.map((entry) => entry.weights.sizeBytes / 1e9);
    expect(sizes.some((size) => size < 4)).toBe(true);
    expect(sizes.some((size) => size >= 5 && size < 9)).toBe(true);
    expect(sizes.some((size) => size >= 12 && size < 16)).toBe(true);
    expect(sizes.some((size) => size >= 19 && size < 26)).toBe(true);
    expect(sizes.some((size) => size >= 28 && size < 32)).toBe(true);
    expect(sizes.some((size) => size >= 36 && size < 40)).toBe(true);
  });
});

describe('budget', () => {
  it('keeps a buffer of 10% of RAM, at least 4 GiB (a quarter of a small machine), at most 8 GiB', () => {
    expect(memoryBuffer(8 * GIB)).toBe(2 * GIB);
    expect(memoryBuffer(16 * GIB)).toBe(4 * GIB);
    expect(memoryBuffer(32 * GIB)).toBe(4 * GIB);
    expect(memoryBuffer(57.6 * GIB)).toBeCloseTo(5.76 * GIB);
    expect(memoryBuffer(128 * GIB)).toBe(8 * GIB);
  });

  it('adds a start margin of 5% of RAM, 1 to 4 GiB', () => {
    expect(startMargin(8 * GIB)).toBe(1 * GIB);
    expect(startMargin(57.6 * GIB)).toBeCloseTo(2.88 * GIB);
    expect(startMargin(128 * GIB)).toBe(4 * GIB);
  });

  it('is available memory less the buffer and the margin, with no fixed ceiling', () => {
    expect(memoryBudget(ZEN4).ramBytes).toBeCloseTo(40 * GIB - 5.76 * GIB - 2.88 * GIB);
    expect(memoryBudget(ZEN4).bufferBytes).toBeCloseTo(5.76 * GIB);
    const idle = { ...ZEN4, availableRamBytes: 56 * GIB };
    expect(memoryBudget(idle).ramBytes).toBeCloseTo(56 * GIB - 8.64 * GIB);
    expect(memoryBudget({ ...ZEN4, availableRamBytes: 1 * GIB }).ramBytes).toBe(0);
  });

  it('does not use an APU\'s graphics', () => {
    expect(memoryBudget(ZEN4).gpu).toBeUndefined();
  });

  it('gives a discrete card its free memory less max(512 MiB, 10%)', () => {
    const rig: HardwareProfile = {
      ...ZEN4, gpus: [{ name: 'RTX 4090', vendor: 'nvidia', backend: 'cuda', vramBytes: 24 * GIB, freeVramBytes: 23 * GIB, unified: false, integrated: false }],
    };
    expect(vramReserve(4 * GIB)).toBe(512 * 1024 ** 2);
    expect(memoryBudget(rig).gpu).toMatchObject({ backend: 'cuda', bytes: 23 * GIB - 2.4 * GIB, unified: false });
  });

  it('skips a Vulkan card when there is no Vulkan loader', () => {
    const rig: HardwareProfile = {
      ...ZEN4, vulkanLoader: false,
      gpus: [{ name: 'RX 7900', vendor: 'amd', backend: 'vulkan', vramBytes: 24 * GIB, unified: false, integrated: false }],
    };
    expect(memoryBudget(rig).gpu).toBeUndefined();
  });

  it('holds Apple Silicon\'s GPU to 70% of RAM', () => {
    const mac: HardwareProfile = {
      platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M3 Max', physicalCores: 14, logicalCores: 14,
      totalRamBytes: 64 * GIB, availableRamBytes: 60 * GIB, vulkanLoader: false,
      gpus: [{ name: 'Apple M3 Max', vendor: 'apple', backend: 'metal', vramBytes: 64 * GIB, unified: true, integrated: true }],
    };
    expect(memoryBudget(mac).gpu).toMatchObject({ backend: 'metal', bytes: 64 * GIB * 0.7, unified: true });
  });
});

describe('KV cache', () => {
  it('counts only the full-attention layers of a hybrid', () => {
    // Qwen3.5 4B: 8 attention layers x 4 KV heads x (256 + 256) x 2 bytes.
    const kv = model('qwen3.5-4b').kv;
    expect(kvCacheBytes({ ...kv, recurrentStateBytes: 0 }, 65_536, 'f16', 1)).toBe(8 * 4 * 512 * 2 * 65_536);
  });

  it('holds sliding-window layers to their window', () => {
    const kv = model('gpt-oss-20b').kv;
    const at16k = kvCacheBytes(kv, 16_384, 'f16', 1);
    const at64k = kvCacheBytes(kv, 65_536, 'f16', 1);
    // Only the 12 full layers grow with context.
    expect(at64k - at16k).toBe(12 * 8 * 128 * 2 * (65_536 - 16_384));
  });

  it('uses f16 only with 16 GiB of headroom beyond the weights', () => {
    expect(chooseCacheType(36 * GIB, 21.7e9)).toBe('q8_0');
    expect(chooseCacheType(37 * GIB, 21.7e9)).toBe('f16');
    expect(chooseCacheType(34 * GIB, 2.7e9)).toBe('f16');
  });
});

describe('fit', () => {
  it('fits Ornith on the Zen 4 on the CPU, by the estimate before it has run', () => {
    const fit = fitModel(model('ornith-1.5-35b-a3b'), memoryBudget(ZEN4));
    expect(fit).toMatchObject({ fits: true, placement: 'cpu', cacheType: 'f16' });
    expect(fit.measured).toBeUndefined();
    expect(fit.context).toBeGreaterThanOrEqual(65_536);
  });

  it('shrinks the context before giving up, but not below the minimum', () => {
    const ornith = model('ornith-1.5-35b-a3b');
    const at64k = fitModel(ornith, { ramBytes: 1e12, bufferBytes: 0, ramReserveBytes: 0 }, { context: 65_536 });
    const at16k = fitModel(ornith, { ramBytes: 1e12, bufferBytes: 0, ramReserveBytes: 0 }, { context: MIN_CONTEXT });
    const tight = fitModel(ornith, { ramBytes: at64k.needBytes - (at64k.needBytes - at16k.needBytes) / 2, bufferBytes: 0, ramReserveBytes: 0 });
    expect(tight.fits).toBe(true);
    expect(tight.context).toBeLessThan(65_536);
    expect(tight.context).toBeGreaterThanOrEqual(MIN_CONTEXT);
  });

  it('tries the model\'s maximum context first, halving down to the minimum, default included', () => {
    expect(contextsToTry({ defaultContext: 65_536, maxContext: 262_144 })).toEqual([262_144, 131_072, 65_536, 32_768, 16_384]);
    expect(contextsToTry({ defaultContext: 40_000, maxContext: 131_072 })).toEqual([131_072, 65_536, 40_000, 32_768, 16_384]);
    expect(contextsToTry({ defaultContext: 65_536, maxContext: 262_144 }, 100_000)).toEqual([100_000]);
  });

  it('uses spare memory for a longer context, leaving the prompt cache its room past the default', () => {
    const qwen = model('qwen3.5-4b');
    const at256k = fitModel(qwen, { ramBytes: 1e12, bufferBytes: 0, ramReserveBytes: 0 }, { context: 262_144 });
    expect(at256k.cacheType).toBe('f16');
    const roomy = fitModel(qwen, { ramBytes: at256k.needBytes + PROMPT_CACHE_ALLOWANCE, bufferBytes: 0, ramReserveBytes: 0 });
    expect(roomy).toMatchObject({ context: 262_144, cacheType: 'f16' });
    // Without the prompt cache's room the maximum is given up for the next step down.
    const short = fitModel(qwen, { ramBytes: at256k.needBytes + PROMPT_CACHE_ALLOWANCE - 1, bufferBytes: 0, ramReserveBytes: 0 });
    expect(short).toMatchObject({ context: 131_072, cacheType: 'f16' });
  });

  it('takes an f16 cache at a shorter context over q8_0 at a longer one on the CPU, and q8_0 only when f16 fits nowhere', () => {
    const qwen = model('qwen3.5-4b');
    // 10 GiB would hold q8_0 at 256K; f16 at a shorter context is taken instead.
    expect(fitModel(qwen, { ramBytes: 10 * GIB, bufferBytes: 0, ramReserveBytes: 0 })).toMatchObject({ fits: true, cacheType: 'f16' });
    const f16Min = fitModel(qwen, { ramBytes: 1e12, bufferBytes: 0, ramReserveBytes: 0 }, { context: MIN_CONTEXT });
    const tooSmallForF16 = fitModel(qwen, { ramBytes: f16Min.needBytes - 1, bufferBytes: 0, ramReserveBytes: 0 }, { context: MIN_CONTEXT });
    expect(tooSmallForF16).toMatchObject({ fits: true, cacheType: 'q8_0', context: MIN_CONTEXT });
  });

  it('says why a model does not fit', () => {
    const fit = fitModel(model('qwen3.8-27b'), { ramBytes: 8 * GIB, ramReserveBytes: 2 * GIB });
    expect(fit.fits).toBe(false);
    expect(fit.reason).toMatch(/needs .* GB at 16K context; 8\.6 GB of RAM is free for models/);
  });

  it('puts a model wholly on a card that holds it, partly on one that holds a quarter', () => {
    const budget = (gpuBytes: number) => ({
      ramBytes: 30 * GIB, ramReserveBytes: 4 * GIB,
      gpu: { backend: 'cuda' as const, bytes: gpuBytes, devices: [], unified: false, fitTargetMib: 1024 },
    });
    expect(fitModel(model('qwen3.5-9b'), budget(22 * GIB)).placement).toBe('gpu');
    expect(fitModel(model('ornith-1.5-35b-a3b'), budget(10 * GIB)).placement).toBe('gpu-partial');
    expect(fitModel(model('ornith-1.5-35b-a3b'), budget(2 * GIB)).placement).toBe('cpu');
  });
});

describe('fit from a measured footprint', () => {
  // Ornith 35B-A3B at 64K, f16, measured on the Zen 4 while it still mapped
  // its weights: 15.2 GB RssAnon plus 20.5 GB RssFile for a 21.7 GB file --
  // repacked tensors counted twice.
  const mappedRun: Footprint = {
    context: 65_536, cacheType: 'f16', parallel: 2, vision: false, anonBytes: 15.2e9, fileBytes: 20.5e9, at: '2026-09-27T00:00:00Z',
  };
  // The same model reading its weights into memory: one copy of each tensor.
  const readRun: Footprint = { ...mappedRun, anonBytes: 23.5e9, fileBytes: 0, mmap: false };

  it('is the estimate until the model has run', () => {
    expect(measuredNeed(model('ornith-1.5-35b-a3b'), [], 65_536, 'f16', 2, false)).toBeUndefined();
  });

  it('ignores runs that mapped their weights, which double-count them', () => {
    expect(measuredNeed(model('ornith-1.5-35b-a3b'), [mappedRun], 65_536, 'f16', 2, false)).toBeUndefined();
    expect(measuredNeed(model('ornith-1.5-35b-a3b'), [{ ...mappedRun, mmap: true }], 65_536, 'f16', 2, false)).toBeUndefined();
  });

  it('is the measured peak at the measured configuration', () => {
    expect(measuredNeed(model('ornith-1.5-35b-a3b'), [mappedRun, readRun], 65_536, 'f16', 2, false)).toBeCloseTo(23.5e9);
  });

  it('adjusts by the KV cache difference for another context or cache type', () => {
    const ornith = model('ornith-1.5-35b-a3b');
    const at32k = measuredNeed(ornith, [readRun], 32_768, 'q8_0', 2, false)!;
    expect(at32k).toBeCloseTo(23.5e9 + kvCacheBytes(ornith.kv, 32_768, 'q8_0', 2) - kvCacheBytes(ornith.kv, 65_536, 'f16', 2));
    expect(at32k).toBeLessThan(23.5e9);
    // A different slot count changes buffers the adjustment does not model.
    expect(measuredNeed(ornith, [readRun], 65_536, 'f16', 4, false)).toBeUndefined();
    // Vision adds the projector.
    expect(measuredNeed(ornith, [readRun], 65_536, 'f16', 2, true)).toBeCloseTo(23.5e9 + ornith.projector!.sizeBytes);
  });

  it('prefers the nearest run: same cache type, then nearest context', () => {
    const ornith = model('ornith-1.5-35b-a3b');
    const other: Footprint = { ...readRun, cacheType: 'q8_0', context: 16_384, anonBytes: 10e9 };
    const need = measuredNeed(ornith, [other, readRun], 131_072, 'f16', 2, false)!;
    expect(need).toBeCloseTo(23.5e9 + kvCacheBytes(ornith.kv, 131_072, 'f16', 2) - kvCacheBytes(ornith.kv, 65_536, 'f16', 2));
  });

  it('fits Ornith at 39 GB available: weights, cache and buffers counted once', () => {
    const machine = { ...ZEN4, availableRamBytes: 39e9 };
    const estimated = fitModel(model('ornith-1.5-35b-a3b'), memoryBudget(machine), { footprints: [mappedRun] });
    expect(estimated).toMatchObject({ fits: true, placement: 'cpu' });
    expect(estimated.measured).toBeUndefined();
    expect(estimated.context).toBeGreaterThanOrEqual(65_536);
    expect(estimated.needBytes).toBeLessThan(21.7e9 + 5e9);
  });

  it('decides the fit by what the model really held, not the estimate', () => {
    const ornith = model('ornith-1.5-35b-a3b');
    const machine = { ...ZEN4, availableRamBytes: 39e9 };
    // A run that held far more than estimated keeps it out.
    const heavy: Footprint = { ...readRun, anonBytes: 33e9 };
    expect(fitModel(ornith, memoryBudget(machine), { footprints: [heavy] })).toMatchObject({ fits: false, measured: true });
    const fit = fitModel(ornith, memoryBudget(machine), { footprints: [readRun] });
    expect(fit).toMatchObject({ fits: true, measured: true });
    expect(fit.needBytes + (fit.context > 65_536 ? PROMPT_CACHE_ALLOWANCE : 0)).toBeLessThanOrEqual(memoryBudget(machine).ramBytes);
  });

  it('ranks with the measured footprint', () => {
    const machine = { ...ZEN4, availableRamBytes: 39e9 };
    const ornithFits = (footprints: Footprint[]) => rankModels(LOCAL_MODEL_CATALOG, machine, memoryBudget(machine), {}, { 'ornith-1.5-35b-a3b': footprints })
      .find((row) => row.model.id === 'ornith-1.5-35b-a3b')!.fit.fits;
    expect(ornithFits([mappedRun])).toBe(true);
    expect(ornithFits([{ ...readRun, anonBytes: 33e9 }])).toBe(false);
  });
});

describe('speed estimate', () => {
  it('lands within 15% of what Ornith measured on the Zen 4 (97 reading, 20 writing)', () => {
    const ornith = model('ornith-1.5-35b-a3b');
    const estimate = estimateSpeed(ornith, ZEN4, fitModel(ornith, memoryBudget(ZEN4)));
    expect(Math.abs(estimate.promptPerSecond - 97) / 97).toBeLessThan(0.15);
    expect(Math.abs(estimate.generatePerSecond - 20) / 20).toBeLessThan(0.15);
  });

  it('scales reading with cores', () => {
    const small = model('qwen3.5-4b');
    const fit = fitModel(small, memoryBudget(ZEN4));
    const four = estimateSpeed(small, { ...ZEN4, physicalCores: 4 }, fit).promptPerSecond;
    expect(estimateSpeed(small, ZEN4, fit).promptPerSecond).toBeCloseTo(four * 2);
  });

  it('puts a dense 27B far under the bar on a CPU', () => {
    const dense = model('qwen3.8-27b');
    const estimate = estimateSpeed(dense, ZEN4, { placement: 'cpu', gpuBytes: 0, needBytes: 1 });
    expect(meetsBar(estimate)).toBe(false);
    expect(estimate.promptPerSecond).toBeLessThan(15);
  });
});

describe('ranking and choice', () => {
  const budget = memoryBudget(ZEN4);

  it('sizes CPU context by a deep turn instead of taking the largest window memory permits', () => {
    const small = model('qwen3.5-4b');
    const memoryOnly = fitModel(small, budget);
    const ranked = rankModels([small], ZEN4, budget, {})[0]!;
    expect(memoryOnly.context).toBeGreaterThan(65_536);
    expect(ranked.fit.context).toBe(16_384);
    expect(ranked.speed.generatePerSecond).toBeLessThan(8);
  });

  it('offers the best model that meets the bar first, slow ones after, misfits last', () => {
    const ranked = rankModels(LOCAL_MODEL_CATALOG, ZEN4, budget, {});
    expect(ranked[0]!.model.id).toBe('ornith-1.5-35b-a3b-q6');
    const passing = ranked.filter((row) => row.passes).map((row) => row.model.quality);
    expect(passing).toEqual([...passing].sort((left, right) => right - left));
    const firstSlow = ranked.findIndex((row) => !row.passes);
    expect(ranked.slice(firstSlow).every((row) => !row.passes)).toBe(true);
    expect(ranked.find((row) => row.model.id === 'qwen3.8-27b')!.passes).toBe(false);
  });

  it('takes the most precise build of the best model that fits the deep-turn target', () => {
    // The Zen 4's ~34 GiB takes Ornith at Q6_K but not at Q8_0; with less
    // free, the Q4_K_M. More RAM alone does not make Q8 fast enough for
    // the deep-turn bar; on a 48 GB card, Qwen3.8 27B at Q8_0.
    const ranked = rankModels(LOCAL_MODEL_CATALOG, ZEN4, budget, {});
    expect(ranked.find((row) => row.model.id === 'ornith-1.5-35b-a3b-q8')!.fit.fits).toBe(false);
    const busy = memoryBudget({ ...ZEN4, availableRamBytes: 32 * GIB });
    expect(rankModels(LOCAL_MODEL_CATALOG, ZEN4, busy, {})[0]!.model.id).toBe('ornith-1.5-35b-a3b');
    const bigRam = memoryBudget({ ...ZEN4, totalRamBytes: 96 * GIB, availableRamBytes: 80 * GIB });
    expect(rankModels(LOCAL_MODEL_CATALOG, ZEN4, bigRam, {})[0]!.model.id).toBe('ornith-1.5-35b-a3b-q6');
    const card: HardwareProfile = {
      ...ZEN4, gpus: [{ name: 'RTX 6000 Ada', vendor: 'nvidia', backend: 'cuda', vramBytes: 48 * GIB, freeVramBytes: 47 * GIB, unified: false, integrated: false }],
    };
    const top = rankModels(LOCAL_MODEL_CATALOG, card, memoryBudget(card), {})[0]!;
    expect(top.model.id).toBe('qwen3.8-27b-q8');
    expect(top.fit.placement).toBe('gpu');
  });

  it('lets a measurement override the estimate', () => {
    const slowOrnith = { 'ornith-1.5-35b-a3b-q6': { promptPerSecond: 20, generatePerSecond: 4, toolCalls: true, at: '' } };
    const ranked = rankModels(LOCAL_MODEL_CATALOG, ZEN4, budget, slowOrnith);
    expect(ranked[0]!.model.id).toBe('ornith-1.5-35b-a3b');
    const calibrated = ranked.find((row) => row.model.id === 'ornith-1.5-35b-a3b-q6')!;
    expect(calibrated.speed.promptPerSecond).toBeLessThan(20);
    expect(calibrated.speed.promptPerSecond).toBeGreaterThan(0);
    expect(calibrated.passes).toBe(false);
  });

  it('drops a model that measured no tool calls below those that did', () => {
    const noTools = { 'ornith-1.5-35b-a3b': { promptPerSecond: 97, generatePerSecond: 20, toolCalls: false, at: '' } };
    expect(rankModels(LOCAL_MODEL_CATALOG, ZEN4, budget, noTools).find((row) => row.model.id === 'ornith-1.5-35b-a3b')!.passes).toBe(false);
  });

  it('keeps the user\'s pick even when it is slow, but not when it does not fit', () => {
    const ranked = rankModels(LOCAL_MODEL_CATALOG, ZEN4, budget, {});
    expect(chooseModel(ranked, 'qwen3.8-27b').row.model.id).toBe('qwen3.8-27b');
    const small = rankModels(LOCAL_MODEL_CATALOG, ZEN4, { ramBytes: 6 * GIB, ramReserveBytes: 2 * GIB }, {});
    expect(() => chooseModel(small, 'ornith-1.5-35b-a3b')).toThrow(/does not fit/);
    expect(() => chooseModel(ranked, 'no-such-model')).toThrow(/not a ClikCode Local model/);
  });

  it('falls back to the fastest fitting model, with a notice, when none meets the bar', () => {
    const slowBox: HardwareProfile = { ...ZEN4, physicalCores: 2, logicalCores: 4 };
    const choice = chooseModel(rankModels(LOCAL_MODEL_CATALOG, slowBox, budget, {}));
    expect(choice.notice).toMatch(/fastest that fits/);
  });
});

describe('launch settings', () => {
  it('writes at the physical cores and reads at 1.5x them', () => {
    expect(threadPlan({ physicalCores: 8, logicalCores: 16 })).toEqual({ threads: 8, threadsBatch: 12 });
    expect(threadPlan({ physicalCores: 8, logicalCores: 8 })).toEqual({ threads: 8, threadsBatch: 8 });
  });

  it('leaves a core free on small machines', () => {
    expect(threadPlan({ physicalCores: 4, logicalCores: 8 })).toEqual({ threads: 3, threadsBatch: 4 });
    expect(threadPlan({ physicalCores: 1, logicalCores: 1 })).toEqual({ threads: 1, threadsBatch: 1 });
  });

  it('binds to loopback with jinja templates, flash attention and the chosen cache', () => {
    const args = buildServerArgs({
      modelPath: '/m.gguf', port: 43210, alias: 'qwen3.5-4b', cacheRamMib: 2048,
      fit: { placement: 'cpu', context: 65_536, cacheType: 'f16', parallel: 2 },
      threads: { threads: 8, threadsBatch: 12 },
    });
    expect(args.join(' ')).toBe('--host 127.0.0.1 --port 43210 -m /m.gguf -a qwen3.5-4b -c 65536 -np 2 --kv-unified --jinja -fa on -t 8 -tb 12 '
      + '-ctk f16 -ctv f16 --cache-ram 2048 --no-webui --load-mode none -ngl 0');
    expect(buildServerArgs({
      modelPath: '/m.gguf', port: 1, alias: 'a', cacheRamMib: 0, slotSavePath: '/s/prefix-cache/f16',
      fit: { placement: 'cpu', context: 8192, cacheType: 'f16', parallel: 2 }, threads: { threads: 8, threadsBatch: 12 },
    }).join(' ')).toContain('--slot-save-path /s/prefix-cache/f16');
  });

  it('reads the weights into memory on the CPU and maps them on a GPU', () => {
    expect(usesMmap('cpu')).toBe(false);
    expect(usesMmap('gpu')).toBe(true);
    expect(usesMmap('gpu-partial')).toBe(true);
    const base = { modelPath: '/m.gguf', port: 1, alias: 'a', cacheRamMib: 0, threads: { threads: 8, threadsBatch: 12 } };
    for (const placement of ['gpu', 'gpu-partial'] as const) {
      expect(buildServerArgs({ ...base, fit: { placement, context: 8192, cacheType: 'f16', parallel: 4 } })).not.toContain('--load-mode');
    }
  });

  it('offloads all layers, or lets llama.cpp fit them with a margin', () => {
    const base = { modelPath: '/m.gguf', port: 1, alias: 'a', cacheRamMib: 0, threads: { threads: 8, threadsBatch: 12 }, fitTargetMib: 2458 };
    expect(buildServerArgs({ ...base, fit: { placement: 'gpu', context: 8192, cacheType: 'f16', parallel: 4 } })).toContain('all');
    expect(buildServerArgs({ ...base, fit: { placement: 'gpu-partial', context: 8192, cacheType: 'f16', parallel: 4 } }).join(' '))
      .toContain('-ngl auto --fit on --fit-target 2458');
  });
});

describe('runtime build', () => {
  it('picks the CPU build for this machine', () => {
    expect(selectRuntimeBuild(ZEN4, undefined)?.key).toBe('linux-x64-cpu');
  });

  it('picks CUDA 13 for a new driver, CUDA 12 for an older one', () => {
    const gpu = (driverVersion: string) => ({
      backend: 'cuda' as const, bytes: 20 * GIB, unified: false, fitTargetMib: 1024,
      devices: [{ name: 'RTX', vendor: 'nvidia' as const, backend: 'cuda' as const, vramBytes: 24 * GIB, unified: false, integrated: false, driverVersion }],
    });
    expect(selectRuntimeBuild(ZEN4, gpu('580.65.06'))?.key).toBe('linux-x64-cuda13');
    expect(selectRuntimeBuild(ZEN4, gpu('550.54.15'))?.key).toBe('linux-x64-cuda12');
    expect(selectRuntimeBuild({ platform: 'win32', arch: 'x64' }, gpu('560.1'))?.key).toBe('win32-x64-cuda12');
  });

  it('uses Metal on Apple Silicon and the CPU build where a backend has none', () => {
    expect(selectRuntimeBuild({ platform: 'darwin', arch: 'arm64' }, undefined)?.key).toBe('darwin-arm64-metal');
    const rocm = { backend: 'rocm' as const, bytes: 10 * GIB, unified: false, fitTargetMib: 1024, devices: [] };
    expect(selectRuntimeBuild({ platform: 'linux', arch: 'arm64' }, rocm)?.key).toBe('linux-arm64-cpu');
  });
});

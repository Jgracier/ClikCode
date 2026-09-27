import { describe, expect, it } from 'vitest';
import { memoryBudget, ramReserve, vramReserve } from './budget';
import { LOCAL_MODEL_CATALOG, catalogModel, type CatalogModel } from './catalog';
import {
  chooseCacheType, chooseModel, estimateSpeed, fitModel, kvCacheBytes, meetsBar, rankModels, MIN_CONTEXT,
} from './choose';
import type { HardwareProfile } from './hardware';
import { buildServerArgs, threadPlan } from './launch';
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
  it('leaves a reserve of 10% of RAM, between 2 and 6 GiB', () => {
    expect(ramReserve(8 * GIB)).toBe(2 * GIB);
    expect(ramReserve(32 * GIB)).toBeCloseTo(3.2 * GIB);
    expect(ramReserve(128 * GIB)).toBe(6 * GIB);
  });

  it('is available memory less the reserve, capped at 80% of RAM', () => {
    expect(memoryBudget(ZEN4).ramBytes).toBeCloseTo(40 * GIB - 5.76 * GIB);
    const idle = { ...ZEN4, availableRamBytes: 56 * GIB };
    expect(memoryBudget(idle).ramBytes).toBeCloseTo(57.6 * GIB * 0.8);
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
  it('fits Ornith on the Zen 4 on the CPU at its default context', () => {
    const fit = fitModel(model('ornith-1.5-35b-a3b'), memoryBudget(ZEN4));
    expect(fit).toMatchObject({ fits: true, placement: 'cpu', context: 65_536, cacheType: 'q8_0' });
    expect(fit.needBytes).toBeLessThan(25 * GIB);
  });

  it('shrinks the context before giving up, but not below the minimum', () => {
    const ornith = model('ornith-1.5-35b-a3b');
    const full = fitModel(ornith, { ramBytes: 1e12, ramReserveBytes: 0 });
    const kvAt64k = full.needBytes - fitModel(ornith, { ramBytes: 1e12, ramReserveBytes: 0 }, { context: MIN_CONTEXT }).needBytes;
    const tight = fitModel(ornith, { ramBytes: full.needBytes - kvAt64k / 2, ramReserveBytes: 0 });
    expect(tight.fits).toBe(true);
    expect(tight.context).toBeLessThan(65_536);
    expect(tight.context).toBeGreaterThanOrEqual(MIN_CONTEXT);
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

  it('offers the best model that meets the bar first, slow ones after, misfits last', () => {
    const ranked = rankModels(LOCAL_MODEL_CATALOG, ZEN4, budget, {});
    expect(ranked[0]!.model.id).toBe('ornith-1.5-35b-a3b-q6');
    const passing = ranked.filter((row) => row.passes).map((row) => row.model.quality);
    expect(passing).toEqual([...passing].sort((left, right) => right - left));
    const firstSlow = ranked.findIndex((row) => !row.passes);
    expect(ranked.slice(firstSlow).every((row) => !row.passes)).toBe(true);
    expect(ranked.find((row) => row.model.id === 'qwen3.8-27b')!.passes).toBe(false);
  });

  it('takes the most precise build of the best model the memory holds', () => {
    // The Zen 4's ~34 GiB takes Ornith at Q6_K but not at Q8_0; with less
    // free, the Q4_K_M; on a 48 GB card, Qwen3.8 27B at Q8_0.
    const ranked = rankModels(LOCAL_MODEL_CATALOG, ZEN4, budget, {});
    expect(ranked.find((row) => row.model.id === 'ornith-1.5-35b-a3b-q8')!.fit.fits).toBe(false);
    const busy = memoryBudget({ ...ZEN4, availableRamBytes: 32 * GIB });
    expect(rankModels(LOCAL_MODEL_CATALOG, ZEN4, busy, {})[0]!.model.id).toBe('ornith-1.5-35b-a3b');
    const bigRam = memoryBudget({ ...ZEN4, totalRamBytes: 96 * GIB, availableRamBytes: 80 * GIB });
    expect(rankModels(LOCAL_MODEL_CATALOG, ZEN4, bigRam, {})[0]!.model.id).toBe('ornith-1.5-35b-a3b-q8');
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
    expect(ranked.find((row) => row.model.id === 'ornith-1.5-35b-a3b-q6')!.speed.promptPerSecond).toBe(20);
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
      + '-ctk f16 -ctv f16 --cache-ram 2048 --no-webui -ngl 0');
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

import { describe, expect, it } from 'vitest';
import { memoryBudget, MIN_CONTEXT } from './shared/index.js';
import { catalogModels } from './catalog-source';
import type { CatalogModel } from './catalog';
import type { HardwareProfile } from './hardware';
import { buildServerArgs, threadPlan, usesMmap } from './launch';
import { selectRuntimeBuild } from './runtime';

const GIB = 1024 ** 3;
const LOCAL_MODEL_CATALOG = catalogModels();

/** The machine the speed constants were measured on. */
const ZEN4: HardwareProfile = {
  platform: 'linux', arch: 'x64', cpuModel: 'AMD Ryzen 7 8745HS w/ Radeon 780M Graphics',
  physicalCores: 8, logicalCores: 16, totalRamBytes: 57.6 * GIB, availableRamBytes: 40 * GIB,
  gpus: [{ name: 'Radeon 780M Graphics', vendor: 'amd', backend: 'vulkan', vramBytes: 4 * GIB, unified: true, integrated: true }],
  vulkanLoader: true,
};

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
  it('drives an APU\'s graphics with the Vulkan build once its reach is known', () => {
    const apu: HardwareProfile = { ...ZEN4, gpus: [{ ...ZEN4.gpus[0]!, addressableBytes: 33_605 * 1024 ** 2 }] };
    expect(selectRuntimeBuild(apu, memoryBudget(apu).gpu)?.key).toBe('linux-x64-vulkan');
  });

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

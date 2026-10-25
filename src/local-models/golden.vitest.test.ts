/** Golden recommendations: what the fit/speed/ranking math chooses for a spread of machines.
 * Recorded from the hand-written catalog and the in-tree math before they moved to the shared
 * library and the signed catalog; the switch must leave every line of golden.json unchanged.
 * Regenerate deliberately with GOLDEN_UPDATE=1 when the published catalog or the math changes. */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { memoryBudget } from './budget';
import { LOCAL_MODEL_CATALOG } from './catalog';
import { chooseModel, rankModels } from './choose';
import type { GpuInfo, HardwareProfile } from './hardware';

const GIB = 1024 ** 3;
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden.json');

function machine(name: string, overrides: Partial<HardwareProfile>): [string, HardwareProfile] {
  return [name, {
    platform: 'linux', arch: 'x64', cpuModel: 'Generic CPU', physicalCores: 8, logicalCores: 16,
    totalRamBytes: 32 * GIB, availableRamBytes: 24 * GIB, gpus: [], vulkanLoader: false, ...overrides,
  }];
}

function nvidia(vramGiB: number, freeGiB?: number): GpuInfo {
  return {
    name: `NVIDIA ${vramGiB}GB`, vendor: 'nvidia', backend: 'cuda', vramBytes: vramGiB * GIB,
    ...(freeGiB !== undefined ? { freeVramBytes: freeGiB * GIB } : {}), unified: false, integrated: false,
  };
}

const MACHINES: [string, HardwareProfile][] = [
  machine('cpu-only 8GB', { totalRamBytes: 8 * GIB, availableRamBytes: 5 * GIB, physicalCores: 4, logicalCores: 8 }),
  machine('cpu-only 16GB', { totalRamBytes: 16 * GIB, availableRamBytes: 11 * GIB, physicalCores: 6, logicalCores: 12 }),
  machine('cpu-only 32GB', {}),
  machine('cpu-only 64GB', { totalRamBytes: 64 * GIB, availableRamBytes: 50 * GIB, physicalCores: 16, logicalCores: 32 }),
  machine('cpu-only 128GB', { totalRamBytes: 128 * GIB, availableRamBytes: 100 * GIB, physicalCores: 32, logicalCores: 64 }),
  machine('low free memory', { totalRamBytes: 32 * GIB, availableRamBytes: 4 * GIB }),
  machine('nvidia 8GB', { gpus: [nvidia(8)] }),
  machine('nvidia 12GB', { gpus: [nvidia(12, 11)], totalRamBytes: 32 * GIB, availableRamBytes: 20 * GIB }),
  machine('nvidia 16GB small ram', { gpus: [nvidia(16)], totalRamBytes: 16 * GIB, availableRamBytes: 10 * GIB }),
  machine('nvidia 24GB', { gpus: [nvidia(24, 23)], totalRamBytes: 64 * GIB, availableRamBytes: 48 * GIB }),
  machine('nvidia 2x24GB', { gpus: [nvidia(24), nvidia(24)], totalRamBytes: 128 * GIB, availableRamBytes: 100 * GIB }),
  machine('nvidia 48GB', { gpus: [nvidia(48)], totalRamBytes: 128 * GIB, availableRamBytes: 100 * GIB }),
  machine('apple M1 16GB', {
    platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M1', physicalCores: 8, logicalCores: 8, totalRamBytes: 16 * GIB, availableRamBytes: 10 * GIB,
    gpus: [{ name: 'Apple M1', vendor: 'apple', backend: 'metal', vramBytes: 16 * GIB, unified: true, integrated: true }],
  }),
  machine('apple M2 Pro 32GB', {
    platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M2 Pro', physicalCores: 10, logicalCores: 10, totalRamBytes: 32 * GIB, availableRamBytes: 22 * GIB,
    gpus: [{ name: 'Apple M2 Pro', vendor: 'apple', backend: 'metal', vramBytes: 32 * GIB, unified: true, integrated: true }],
  }),
  machine('apple M3 Max 128GB', {
    platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M3 Max', physicalCores: 16, logicalCores: 16, totalRamBytes: 128 * GIB, availableRamBytes: 96 * GIB,
    gpus: [{ name: 'Apple M3 Max', vendor: 'apple', backend: 'metal', vramBytes: 128 * GIB, unified: true, integrated: true }],
  }),
  machine('amd 780M via vulkan reach', {
    cpuModel: 'AMD Ryzen 7 8745HS w/ Radeon 780M Graphics', totalRamBytes: 57.6 * GIB, availableRamBytes: 40 * GIB, vulkanLoader: true,
    gpus: [{ name: 'Radeon 780M Graphics', vendor: 'amd', backend: 'vulkan', vramBytes: 4 * GIB, unified: true, integrated: true, addressableBytes: 30 * GIB }],
  }),
  machine('amd igpu reach unknown', {
    cpuModel: 'AMD Ryzen 7 8745HS w/ Radeon 780M Graphics', totalRamBytes: 32 * GIB, availableRamBytes: 22 * GIB, vulkanLoader: true,
    gpus: [{ name: 'Radeon 780M Graphics', vendor: 'amd', backend: 'vulkan', vramBytes: 4 * GIB, unified: true, integrated: true }],
  }),
  machine('amd discrete rocm 16GB', { gpus: [{ name: 'Radeon RX 7800 XT', vendor: 'amd', backend: 'rocm', vramBytes: 16 * GIB, unified: false, integrated: false }] }),
];

const round = (value: number): number => Math.round(value * 100) / 100;

function recommend(hardware: HardwareProfile): unknown {
  const budget = memoryBudget(hardware);
  const ranked = rankModels(LOCAL_MODEL_CATALOG, hardware, budget, {}, {});
  let chosen: string;
  let notice: string | undefined;
  try {
    const choice = chooseModel(ranked);
    chosen = choice.row.model.id;
    notice = choice.notice;
  } catch (error) { chosen = `error: ${(error as Error).message}`; }
  return {
    chosen, notice: notice ?? null,
    budget: { ram: budget.ramBytes, gpu: budget.gpu?.bytes ?? 0 },
    ranked: ranked.map((row) => ({
      id: row.model.id, fits: row.fit.fits, passes: row.passes, placement: row.fit.placement, context: row.fit.context,
      cache: row.fit.cacheType, need: Math.round(row.fit.needBytes), gpu: Math.round(row.fit.gpuBytes),
      read: round(row.speed.promptPerSecond), write: round(row.speed.generatePerSecond),
      firstBrief: round(row.firstReply.brief), firstLong: round(row.firstReply.long),
    })),
  };
}

describe('golden recommendations', () => {
  const actual = Object.fromEntries(MACHINES.map(([name, hardware]) => [name, recommend(hardware)]));

  it('records a result for every machine', () => {
    expect(Object.keys(actual)).toHaveLength(MACHINES.length);
  });

  it('matches golden.json', () => {
    if (process.env.GOLDEN_UPDATE) writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});

import { describe, expect, it } from 'vitest';
import {
  isIntegratedAmd, parseAmdSmi, parseCpuinfoPhysicalCores, parseLinuxMeminfo, parseNvidiaSmi, parseRocmSmi, parseVmStat, parseWindowsProbe,
} from './hardware';

const GIB = 1024 ** 3;

describe('Linux memory', () => {
  it('reads MemAvailable, not MemFree (the 8-core Zen 4 this was built on)', () => {
    const sample = [
      'MemTotal:       60435252 kB', 'MemFree:         5060900 kB', 'MemAvailable:   34278896 kB',
      'Buffers:          920212 kB', 'Cached:         28773804 kB', 'SwapCached:        33400 kB',
    ].join('\n');
    expect(parseLinuxMeminfo(sample)).toEqual({ totalBytes: 60435252 * 1024, availableBytes: 34278896 * 1024 });
  });

  it('falls back to free + cache + buffers on kernels without MemAvailable', () => {
    const sample = 'MemTotal: 8000000 kB\nMemFree: 1000000 kB\nBuffers: 100000 kB\nCached: 2000000 kB\n';
    expect(parseLinuxMeminfo(sample).availableBytes).toBe(3_100_000 * 1024);
  });
});

describe('physical cores from /proc/cpuinfo', () => {
  it('counts distinct cores, not hyperthreads', () => {
    const block = (processor: number, core: number): string =>
      `processor\t: ${processor}\nmodel name\t: AMD Ryzen 7 8745HS w/ Radeon 780M Graphics\nphysical id\t: 0\nsiblings\t: 16\ncore id\t\t: ${core}\ncpu cores\t: 8\n`;
    const text = Array.from({ length: 16 }, (_, index) => block(index, index % 8)).join('\n');
    expect(parseCpuinfoPhysicalCores(text)).toBe(8);
  });

  it('keeps cores on different sockets apart', () => {
    const text = 'processor : 0\nphysical id : 0\ncore id : 0\n\nprocessor : 1\nphysical id : 1\ncore id : 0\n';
    expect(parseCpuinfoPhysicalCores(text)).toBe(2);
  });

  it('says nothing for ARM kernels, which print no core ids', () => {
    expect(parseCpuinfoPhysicalCores('processor\t: 0\nBogoMIPS\t: 48.00\n\nprocessor\t: 1\nBogoMIPS\t: 48.00\n')).toBeUndefined();
  });
});

describe('macOS vm_stat', () => {
  it('counts free, inactive, speculative and purgeable pages at the stated page size', () => {
    const sample = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               12345.',
      'Pages active:                            400000.',
      'Pages inactive:                          200000.',
      'Pages speculative:                         5000.',
      'Pages throttled:                              0.',
      'Pages wired down:                        150000.',
      'Pages purgeable:                           3000.',
    ].join('\n');
    expect(parseVmStat(sample)).toBe((12345 + 200000 + 5000 + 3000) * 16384);
  });
});

describe('GPU tools', () => {
  it('reads nvidia-smi CSV in MiB', () => {
    const gpus = parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564, 23012, 580.65.06\nNVIDIA GeForce RTX 3060, 12288, 11000, 580.65.06\n');
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toMatchObject({ name: 'NVIDIA GeForce RTX 4090', backend: 'cuda', vramBytes: 24564 * 1024 ** 2, freeVramBytes: 23012 * 1024 ** 2, driverVersion: '580.65.06' });
  });

  it('reads rocm-smi JSON byte counts', () => {
    const json = JSON.stringify({
      card0: { 'VRAM Total Memory (B)': '17163091968', 'VRAM Total Used Memory (B)': '1073741824', 'Card Series': 'Radeon RX 7800 XT' },
      system: { 'Driver version': '6.8.0' },
    });
    expect(parseRocmSmi(json)).toEqual([{
      name: 'Radeon RX 7800 XT', vendor: 'amd', backend: 'rocm', vramBytes: 17163091968, freeVramBytes: 17163091968 - 1073741824, unified: false, integrated: false,
    }]);
  });

  it('reads amd-smi value/unit pairs', () => {
    const json = JSON.stringify([{ gpu: 0, mem_usage: { total_vram: { value: 16368, unit: 'MB' }, free_vram: { value: 15000, unit: 'MB' } } }]);
    expect(parseAmdSmi(json)[0]).toMatchObject({ vramBytes: 16368 * 1024 ** 2, freeVramBytes: 15000 * 1024 ** 2, backend: 'rocm' });
  });

  it('ignores output that is not what it expects', () => {
    expect(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.')).toEqual([]);
    expect(parseRocmSmi('not json')).toEqual([]);
    expect(parseAmdSmi('{}')).toEqual([]);
  });

  it('tells an APU\'s carve-out from a card', () => {
    expect(isIntegratedAmd('AMD Ryzen 7 8745HS w/ Radeon 780M Graphics', 4 * GIB)).toBe(true);
    expect(isIntegratedAmd('AMD Ryzen 9 7950X 16-Core Processor', 16 * GIB)).toBe(false);
    expect(isIntegratedAmd('Intel(R) Core(TM) i7-13700K', 4 * GIB)).toBe(false);
  });
});

describe('Windows probe', () => {
  it('reads KiB memory, sums sockets, and takes one or many adapters', () => {
    const json = JSON.stringify({
      os: { TotalVisibleMemorySize: 33_417_000, FreePhysicalMemory: 20_000_000 },
      cpu: { Name: 'AMD Ryzen 9 5900X 12-Core Processor ', NumberOfCores: 12, NumberOfLogicalProcessors: 24 },
      gpu: [{ Name: 'NVIDIA GeForce RTX 3080', AdapterRAM: 4293918720 }, { Name: 'Microsoft Basic Display Adapter', AdapterRAM: 0 }],
    });
    expect(parseWindowsProbe(json)).toEqual({
      totalRamBytes: 33_417_000 * 1024, availableRamBytes: 20_000_000 * 1024, physicalCores: 12, logicalCores: 24,
      cpuModel: 'AMD Ryzen 9 5900X 12-Core Processor',
      adapters: [{ name: 'NVIDIA GeForce RTX 3080', ramBytes: 4293918720 }, { name: 'Microsoft Basic Display Adapter' }],
    });
  });

  it('returns nothing for unparseable output', () => {
    expect(parseWindowsProbe('Get-CimInstance : Access denied')).toBeUndefined();
  });
});

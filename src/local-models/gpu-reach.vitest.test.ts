import { describe, expect, it } from 'vitest';
import { matchDevice, parseListedDevices } from './gpu-reach';

const MIB = 1024 ** 2;

describe('integrated GPU reach from llama.cpp', () => {
  it('reads each Vulkan device and the heap it can use', () => {
    const text = [
      'load_backend: loaded Vulkan backend from /x/libggml-vulkan.so',
      'Available devices:',
      '  Vulkan0: AMD Radeon 780M Graphics (RADV PHOENIX) (33605 MiB, 31901 MiB free)',
      '  Vulkan1: NVIDIA GeForce RTX 4060 (8188 MiB, 7900 MiB free)',
    ].join('\n');
    expect(parseListedDevices(text)).toEqual([
      { name: 'AMD Radeon 780M Graphics (RADV PHOENIX)', totalBytes: 33_605 * MIB },
      { name: 'NVIDIA GeForce RTX 4060', totalBytes: 8_188 * MIB },
    ]);
    expect(parseListedDevices('Available devices:\n')).toEqual([]);
  });

  it('matches the GPU by its name, whatever trademark marks the OS adds', () => {
    const devices = [
      { name: 'AMD Radeon 780M Graphics (RADV PHOENIX)', totalBytes: 1 },
      { name: 'NVIDIA GeForce RTX 4060', totalBytes: 2 },
    ];
    expect(matchDevice({ name: 'AMD Radeon(TM) 780M Graphics' }, devices)?.totalBytes).toBe(1);
    expect(matchDevice({ name: 'Radeon 890M Graphics' }, devices)).toBeUndefined();
    expect(matchDevice({ name: 'anything' }, [devices[0]!])?.totalBytes).toBe(1);
  });
});

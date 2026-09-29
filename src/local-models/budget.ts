/** How much memory a local model may take while the rest of the machine
 * keeps working.
 *
 * Two amounts are kept for other programs, and the model gets the rest of
 * what is available when it starts:
 *  - The buffer: what the supervisor defends while the model runs (see
 *    memwatch.ts). 12% of RAM, at least 4 GiB (or a quarter of RAM on a
 *    machine under 16 GiB, where 4 GiB would be most of what a model has),
 *    at most 8 GiB. It is room for what other programs do next without
 *    swapping -- a browser opening tabs, a build, the editor's language
 *    server -- which on a desktop is a few GB whatever the machine's size,
 *    and more on bigger machines that run bigger workloads.
 *  - The start margin: 2% of RAM, 1-2 GiB, on top of the buffer at start
 *    only. Without it a model sized to the last byte would put spare memory
 *    right on the buffer's edge, and the first ordinary swing of another
 *    program (a tsc run is 1-3 GB) would have the supervisor shrink it. The
 *    margin reduces restarts from small, short-lived memory swings. The
 *    supervisor still backs off when another workload needs its buffer.
 * Available, not total: memory other programs hold now is theirs.
 *
 * There is no fixed ceiling (such as a share of total RAM): a machine
 * measured right after boot, with everything available, is the case the
 * supervisor now covers -- when the user's programs start, it gives memory
 * back.
 *
 * VRAM, per discrete GPU: its free memory less max(512 MiB, 10%). The
 * desktop compositor and browsers keep textures there and fail hard (not
 * slowly, as RAM does) when it runs out.
 *
 * Unified memory (Apple Silicon): one pool. The GPU part is additionally
 * held to 70% of RAM, under the ~75% Metal lets a process wire by default,
 * so a model never depends on that limit being raised. */

import type { GpuBackend, GpuInfo, HardwareProfile } from './hardware.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export interface GpuBudget {
  backend: GpuBackend;
  /** Bytes a model may put on the GPU(s) of this backend, summed. */
  bytes: number;
  devices: GpuInfo[];
  unified: boolean;
  /** The margin passed to llama.cpp's --fit, per device, in MiB. */
  fitTargetMib: number;
}

export interface MemoryBudget {
  ramBytes: number;
  /** Kept free for other programs while the model runs. */
  bufferBytes: number;
  /** Buffer plus start margin: what the start budget left out. */
  ramReserveBytes: number;
  gpu?: GpuBudget;
}

export function memoryBuffer(totalRamBytes: number): number {
  return Math.min(8 * GIB, Math.max(Math.min(4 * GIB, totalRamBytes / 4), totalRamBytes * 0.12));
}

export function startMargin(totalRamBytes: number): number {
  return Math.min(2 * GIB, Math.max(1 * GIB, totalRamBytes * 0.02));
}

export function vramReserve(vramBytes: number): number {
  return Math.max(512 * MIB, vramBytes * 0.1);
}

/** The GPUs worth using: discrete cards, Apple Silicon, and integrated
 * graphics whose reach is known (see GpuInfo.integrated). Of several backends,
 * CUDA is preferred, then ROCm, then Vulkan: the order of llama.cpp's
 * maturity on each. A Vulkan GPU needs a Vulkan loader to be driven at all;
 * ROCm is only reported where rocm-smi or amd-smi exist, so its userspace
 * is installed. */
export function usableGpus(hardware: HardwareProfile): GpuInfo[] {
  const candidates = hardware.gpus.filter((gpu) => gpu.backend === 'metal'
    || ((gpu.integrated ? (gpu.addressableBytes ?? 0) > 0 : gpu.vramBytes > 0) && (gpu.backend !== 'vulkan' || hardware.vulkanLoader)));
  for (const backend of ['metal', 'cuda', 'rocm', 'vulkan'] as const) {
    const matching = candidates.filter((gpu) => gpu.backend === backend);
    if (matching.length) return matching;
  }
  return [];
}

export function memoryBudget(hardware: HardwareProfile): MemoryBudget {
  const buffer = memoryBuffer(hardware.totalRamBytes);
  const reserve = buffer + startMargin(hardware.totalRamBytes);
  const ramBytes = Math.max(0, hardware.availableRamBytes - reserve);
  const devices = usableGpus(hardware);
  if (!devices.length) return { ramBytes, bufferBytes: buffer, ramReserveBytes: reserve };
  const backend = devices[0]!.backend;
  if (devices[0]!.unified) {
    return {
      ramBytes, bufferBytes: buffer, ramReserveBytes: reserve,
      gpu: { backend, bytes: Math.min(ramBytes, hardware.totalRamBytes * 0.7, devices[0]!.addressableBytes ?? Infinity), devices, unified: true, fitTargetMib: Math.round(buffer / MIB) },
    };
  }
  const bytes = devices.reduce((sum, gpu) => sum + Math.max(0, (gpu.freeVramBytes ?? gpu.vramBytes) - vramReserve(gpu.vramBytes)), 0);
  const fitTargetMib = Math.round(Math.max(...devices.map((gpu) => vramReserve(gpu.vramBytes))) / MIB);
  return { ramBytes, bufferBytes: buffer, ramReserveBytes: reserve, gpu: { backend, bytes, devices, unified: false, fitTargetMib } };
}

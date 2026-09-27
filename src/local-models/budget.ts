/** How much memory a local model may take while the rest of the machine
 * keeps working.
 *
 * RAM: what is available right now, less a fixed reserve, and never more
 * than 80% of the machine.
 *  - Available, not total: memory other programs hold now is theirs; taking
 *    it pushes them into swap, which is what "starving other programs"
 *    looks like on a desktop.
 *  - The reserve (10% of RAM, at least 2 GiB, at most 6 GiB) is headroom
 *    for what those programs do next -- a browser opening tabs, a build, the
 *    editor's language server. Proportional because bigger machines run
 *    bigger workloads; capped because past 6 GiB it only locks out models.
 *  - The 80% ceiling covers a machine measured right after boot, when
 *    nearly everything is available and nothing has started yet.
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
  ramReserveBytes: number;
  gpu?: GpuBudget;
}

export function ramReserve(totalRamBytes: number): number {
  return Math.min(6 * GIB, Math.max(2 * GIB, totalRamBytes * 0.1));
}

export function vramReserve(vramBytes: number): number {
  return Math.max(512 * MIB, vramBytes * 0.1);
}

/** The GPUs worth using: discrete cards, or Apple Silicon. Integrated
 * x86 graphics are skipped (see GpuInfo.integrated). Of several backends,
 * CUDA is preferred, then ROCm, then Vulkan: the order of llama.cpp's
 * maturity on each. A Vulkan GPU needs a Vulkan loader to be driven at all;
 * ROCm is only reported where rocm-smi or amd-smi exist, so its userspace
 * is installed. */
export function usableGpus(hardware: HardwareProfile): GpuInfo[] {
  const candidates = hardware.gpus.filter((gpu) => gpu.backend === 'metal'
    || (!gpu.integrated && gpu.vramBytes > 0 && (gpu.backend !== 'vulkan' || hardware.vulkanLoader)));
  for (const backend of ['metal', 'cuda', 'rocm', 'vulkan'] as const) {
    const matching = candidates.filter((gpu) => gpu.backend === backend);
    if (matching.length) return matching;
  }
  return [];
}

export function memoryBudget(hardware: HardwareProfile): MemoryBudget {
  const reserve = ramReserve(hardware.totalRamBytes);
  const ramBytes = Math.max(0, Math.min(hardware.availableRamBytes - reserve, hardware.totalRamBytes * 0.8));
  const devices = usableGpus(hardware);
  if (!devices.length) return { ramBytes, ramReserveBytes: reserve };
  const backend = devices[0]!.backend;
  if (devices[0]!.unified) {
    return {
      ramBytes, ramReserveBytes: reserve,
      gpu: { backend, bytes: Math.min(ramBytes, hardware.totalRamBytes * 0.7), devices, unified: true, fitTargetMib: Math.round(reserve / MIB) },
    };
  }
  const bytes = devices.reduce((sum, gpu) => sum + Math.max(0, (gpu.freeVramBytes ?? gpu.vramBytes) - vramReserve(gpu.vramBytes)), 0);
  const fitTargetMib = Math.round(Math.max(...devices.map((gpu) => vramReserve(gpu.vramBytes))) / MIB);
  return { ramBytes, ramReserveBytes: reserve, gpu: { backend, bytes, devices, unified: false, fitTargetMib } };
}

/** How much memory an integrated GPU can address, asked of llama.cpp itself.
 *
 * The operating system reports only an APU's carve-out (a few GB), but the
 * GPU can also map system RAM; llama.cpp's Vulkan build lists every device
 * with the heap it can use, which is the figure that decides what fits. One
 * way on every OS. It is asked once per runtime build and GPU, only when a
 * model is being started (the Vulkan build is downloaded for it), and the
 * answer is kept so a model picker can use it without asking. */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import type { GpuInfo, HardwareProfile } from './hardware.js';
import { localModelsHome } from './paths.js';
import { ensureRuntime, RUNTIME_BUILDS, type RuntimeBuild, type RuntimeProgress } from './runtime.js';

const MIB = 1024 ** 2;

export interface ListedDevice { name: string; totalBytes: number }

/** `llama-server --list-devices`:
 *   Vulkan0: AMD Radeon 780M Graphics (RADV PHOENIX) (33605 MiB, 31901 MiB free) */
export function parseListedDevices(text: string): ListedDevice[] {
  const devices: ListedDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*Vulkan\d+:\s*(.+?)\s*\((\d+) MiB, \d+ MiB free\)\s*$/.exec(line);
    if (match) devices.push({ name: match[1]!, totalBytes: Number(match[2]) * MIB });
  }
  return devices;
}

/** The listed device that is this GPU: the only one, or the one whose name
 * carries the GPU's (Windows names it "AMD Radeon(TM) 780M Graphics", RADV
 * "AMD Radeon 780M Graphics (RADV PHOENIX)"). */
export function matchDevice(gpu: Pick<GpuInfo, 'name'>, devices: readonly ListedDevice[]): ListedDevice | undefined {
  if (devices.length === 1) return devices[0];
  const words = (text: string): string[] => text.toLowerCase().replace(/\(tm\)|\(r\)/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  const wanted = words(gpu.name);
  const found = devices.filter((device) => { const have = new Set(words(device.name)); return wanted.every((word) => have.has(word)); });
  return found.length === 1 ? found[0] : undefined;
}

/** Integrated GPUs llama.cpp can be asked about. Intel is left out: its
 * integrated graphics have not been measured against its CPU. */
function unknownReach(hardware: HardwareProfile): GpuInfo[] {
  return hardware.vulkanLoader
    ? hardware.gpus.filter((gpu) => gpu.integrated && gpu.vendor === 'amd' && gpu.backend === 'vulkan' && !gpu.addressableBytes)
    : [];
}

function vulkanBuild(hardware: Pick<HardwareProfile, 'platform' | 'arch'>): RuntimeBuild | undefined {
  return RUNTIME_BUILDS.find((build) => build.platform === hardware.platform && build.arch === hardware.arch && build.backend === 'vulkan');
}

function reachFile(): string { return join(localModelsHome(), 'gpu-reach.json'); }
function reachKey(build: RuntimeBuild, gpu: GpuInfo): string { return `${build.key}|${gpu.name}|${gpu.driverVersion ?? ''}`; }

async function readReach(): Promise<Record<string, number>> {
  return JSON.parse(await readFile(reachFile(), 'utf8').catch(() => '{}')) as Record<string, number>;
}

function withReach(hardware: HardwareProfile, build: RuntimeBuild, known: Record<string, number>): HardwareProfile {
  return {
    ...hardware,
    gpus: hardware.gpus.map((gpu) => {
      const reach = unknownReach(hardware).includes(gpu) ? known[reachKey(build, gpu)] : undefined;
      return reach ? { ...gpu, addressableBytes: reach } : gpu;
    }),
  };
}

/** The hardware with every reach already learned filled in. No download,
 * no process: what a model picker calls. */
export async function withKnownReach(hardware: HardwareProfile): Promise<HardwareProfile> {
  const build = vulkanBuild(hardware);
  if (!build || !unknownReach(hardware).length) return hardware;
  return withReach(hardware, build, await readReach());
}

function listDevices(serverPath: string): Promise<string> {
  const variable = process.platform === 'win32' ? 'PATH' : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
  const directory = dirname(serverPath);
  return new Promise((resolve) => {
    execFile(serverPath, ['--list-devices'], {
      timeout: 60_000, windowsHide: true,
      env: { ...process.env, [variable]: [directory, process.env[variable] ?? ''].filter(Boolean).join(delimiter) },
    }, (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`));
  });
}

/** Before a model starts: learn the reach of any integrated GPU that has
 * none yet, by asking the Vulkan build. A GPU llama.cpp does not list keeps
 * no reach, and so stays unused. */
export async function learnGpuReach(hardware: HardwareProfile, progress?: (progress: RuntimeProgress) => void): Promise<HardwareProfile> {
  const build = vulkanBuild(hardware);
  if (!build) return hardware;
  const known = await readReach();
  const missing = unknownReach(hardware).filter((gpu) => known[reachKey(build, gpu)] === undefined);
  if (missing.length) {
    progress?.({ message: 'checking the integrated GPU…' });
    const runtime = await ensureRuntime(build, progress);
    const devices = parseListedDevices(await listDevices(runtime.serverPath));
    // 0 records "asked, not listed", so it is not asked again every start.
    for (const gpu of missing) known[reachKey(build, gpu)] = matchDevice(gpu, devices)?.totalBytes ?? 0;
    await mkdir(dirname(reachFile()), { recursive: true });
    await writeFile(reachFile(), JSON.stringify(known));
  }
  return withReach(hardware, build, known);
}

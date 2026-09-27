/** What this machine has to run a model with: cores, memory that is free
 * right now, and any GPU a prebuilt llama.cpp can use.
 *
 * Every figure comes from the operating system's own report, read by a pure
 * parser that is unit-tested against real samples; the functions that run
 * the commands only glue those together. A probe that fails leaves its
 * part out rather than guessing -- a missing GPU means the CPU is used,
 * which is slow but never wrong. */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';

export type GpuBackend = 'cuda' | 'rocm' | 'metal' | 'vulkan';

export interface GpuInfo {
  name: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';
  /** The backend a prebuilt llama.cpp would drive it with. */
  backend: GpuBackend;
  vramBytes: number;
  /** Unknown when the driver does not report it; the budget then assumes
   * the whole card minus its reserve. */
  freeVramBytes?: number;
  /** Shares system RAM (Apple Silicon, APUs). Its "VRAM" is the RAM the
   * budget already counts, so it is never added on top. */
  unified: boolean;
  /** Built into the CPU package. Its memory bandwidth is the system RAM's,
   * which is what limits generation on a CPU too, so offloading to it buys
   * little and costs driver risk; ClikCode runs such machines on the CPU. */
  integrated: boolean;
  driverVersion?: string;
}

export interface HardwareProfile {
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  physicalCores: number;
  logicalCores: number;
  totalRamBytes: number;
  /** Memory that can be allocated without pushing anything to swap:
   * MemAvailable on Linux, not MemFree, which leaves out reclaimable cache
   * and is small on any machine that has been up a while. */
  availableRamBytes: number;
  gpus: GpuInfo[];
  /** A Vulkan loader is installed, so a Vulkan build of llama.cpp can run. */
  vulkanLoader: boolean;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

// ---- pure parsers ---------------------------------------------------------

/** /proc/meminfo: values are in kB (KiB, despite the name). */
export function parseLinuxMeminfo(text: string): { totalBytes?: number; availableBytes?: number } {
  const field = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  // Kernels before 3.14 have no MemAvailable; free plus page cache is the
  // estimate the kernel itself used before it existed.
  const available = field('MemAvailable') ?? sumDefined(field('MemFree'), field('Cached'), field('Buffers'));
  return { totalBytes: field('MemTotal'), availableBytes: available };
}

function sumDefined(...values: (number | undefined)[]): number | undefined {
  return values.some((value) => value === undefined) ? undefined : values.reduce<number>((sum, value) => sum + value!, 0);
}

/** Physical cores from /proc/cpuinfo: distinct (physical id, core id)
 * pairs. ARM kernels print neither; there every logical CPU is a core. */
export function parseCpuinfoPhysicalCores(text: string): number | undefined {
  const cores = new Set<string>();
  for (const block of text.split(/\n\s*\n/)) {
    const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
    if (core === undefined) continue;
    cores.add(`${/^physical id\s*:\s*(\d+)/m.exec(block)?.[1] ?? '0'}:${core}`);
  }
  return cores.size || undefined;
}

/** macOS `vm_stat`: memory the system hands out without swapping is the
 * free, inactive, speculative and purgeable pages -- what Activity Monitor
 * counts as available. The page size is in the header (16 KiB on Apple
 * Silicon, 4 KiB on Intel). */
export function parseVmStat(text: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages = (label: string): number => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
  const total = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable');
  return total > 0 ? total * pageSize : undefined;
}

/** `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version
 * --format=csv,noheader,nounits`: one line per GPU, memory in MiB. */
export function parseNvidiaSmi(text: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [name, total, free, driver] = line.split(',').map((part) => part.trim());
    if (!name || !Number.isFinite(Number(total)) || !total) continue;
    gpus.push({
      name, vendor: 'nvidia', backend: 'cuda',
      vramBytes: Number(total) * MIB,
      ...(Number.isFinite(Number(free)) && free ? { freeVramBytes: Number(free) * MIB } : {}),
      unified: false, integrated: false,
      ...(driver ? { driverVersion: driver } : {}),
    });
  }
  return gpus;
}

/** `rocm-smi --showmeminfo vram --showproductname --json`: one object per
 * card, byte counts as strings. */
export function parseRocmSmi(text: string): GpuInfo[] {
  let parsed: Record<string, Record<string, string>>;
  try { parsed = JSON.parse(text) as Record<string, Record<string, string>>; } catch { return []; }
  const gpus: GpuInfo[] = [];
  for (const [card, fields] of Object.entries(parsed)) {
    if (!/^card\d+/.test(card) || typeof fields !== 'object') continue;
    const total = Number(fields['VRAM Total Memory (B)']);
    const used = Number(fields['VRAM Total Used Memory (B)']);
    if (!Number.isFinite(total) || total <= 0) continue;
    gpus.push({
      name: fields['Card Series'] || fields['Card series'] || fields['Card SKU'] || card,
      vendor: 'amd', backend: 'rocm', vramBytes: total,
      ...(Number.isFinite(used) ? { freeVramBytes: Math.max(0, total - used) } : {}),
      unified: false, integrated: false,
    });
  }
  return gpus;
}

/** `amd-smi metric --mem-usage --json` (ROCm 6+, which replaces rocm-smi):
 * a list of GPUs, each with value/unit pairs. Older versions wrap the list
 * in an object; both are read. */
export function parseAmdSmi(text: string): GpuInfo[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { gpu_data?: unknown }).gpu_data) ? (parsed as { gpu_data: unknown[] }).gpu_data : [];
  const bytes = (field: unknown): number | undefined => {
    if (!field || typeof field !== 'object') return undefined;
    const { value, unit } = field as { value?: unknown; unit?: unknown };
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    const scale = /^GB$/i.test(String(unit)) ? GIB : /^KB$/i.test(String(unit)) ? 1024 : /^B$/i.test(String(unit)) ? 1 : MIB;
    return number * scale;
  };
  const gpus: GpuInfo[] = [];
  for (const entry of list as { gpu?: number; mem_usage?: Record<string, unknown> }[]) {
    const total = bytes(entry?.mem_usage?.total_vram);
    if (!total) continue;
    const free = bytes(entry.mem_usage?.free_vram);
    gpus.push({
      name: `AMD GPU ${entry.gpu ?? gpus.length}`, vendor: 'amd', backend: 'rocm', vramBytes: total,
      ...(free !== undefined ? { freeVramBytes: free } : {}), unified: false, integrated: false,
    });
  }
  return gpus;
}

export interface WindowsProbe {
  totalRamBytes?: number;
  availableRamBytes?: number;
  physicalCores?: number;
  logicalCores?: number;
  cpuModel?: string;
  adapters: { name: string; ramBytes?: number }[];
}

/** The JSON WINDOWS_PROBE_SCRIPT prints. Win32_OperatingSystem reports
 * memory in KiB; a single CIM instance serializes as an object, several as
 * an array, so both shapes are accepted. */
export function parseWindowsProbe(text: string): WindowsProbe | undefined {
  let parsed: { os?: Record<string, unknown>; cpu?: unknown; gpu?: unknown };
  try { parsed = JSON.parse(text.trim()) as typeof parsed; } catch { return undefined; }
  const many = <T>(value: unknown): T[] => (Array.isArray(value) ? value : value ? [value] : []) as T[];
  const processors = many<{ Name?: string; NumberOfCores?: number; NumberOfLogicalProcessors?: number }>(parsed.cpu);
  const adapters = many<{ Name?: string; AdapterRAM?: number }>(parsed.gpu);
  const kib = (value: unknown): number | undefined => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) * 1024 : undefined;
  const sum = (key: 'NumberOfCores' | 'NumberOfLogicalProcessors'): number | undefined =>
    processors.length ? processors.reduce((total, cpu) => total + (Number(cpu[key]) || 0), 0) || undefined : undefined;
  return {
    totalRamBytes: kib(parsed.os?.TotalVisibleMemorySize),
    availableRamBytes: kib(parsed.os?.FreePhysicalMemory),
    physicalCores: sum('NumberOfCores'),
    logicalCores: sum('NumberOfLogicalProcessors'),
    cpuModel: processors[0]?.Name?.trim(),
    adapters: adapters.filter((adapter) => adapter.Name).map((adapter) => ({
      name: adapter.Name!.trim(),
      ...(Number(adapter.AdapterRAM) > 0 ? { ramBytes: Number(adapter.AdapterRAM) } : {}),
    })),
  };
}

/** An AMD GPU that is part of the CPU: the CPU's own name says it carries
 * Radeon graphics (every Ryzen APU's does: "w/ Radeon 780M Graphics") and
 * the GPU has the small carve-out an APU gets, not a card's memory. */
export function isIntegratedAmd(cpuModel: string, vramBytes: number): boolean {
  return /radeon/i.test(cpuModel) && vramBytes <= 8 * GIB;
}

/** Apple Silicon: one GPU that shares all of RAM. Metal may wire at most
 * about three quarters of it by default (recommendedMaxWorkingSetSize),
 * which is what the budget uses. */
export function appleSiliconGpu(cpuModel: string, totalRamBytes: number): GpuInfo {
  return { name: cpuModel || 'Apple Silicon', vendor: 'apple', backend: 'metal', vramBytes: totalRamBytes, unified: true, integrated: true };
}

// ---- probing --------------------------------------------------------------

function run(command: string, args: readonly string[], timeoutMs = 8000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * MIB }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
}

/** The GPUs amdgpu and i915 expose in sysfs, for machines with no vendor
 * tool installed -- which is most machines with an AMD or Intel GPU. */
function linuxSysfsGpus(cpuModel: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  let cards: string[] = [];
  try { cards = readdirSync('/sys/class/drm').filter((name) => /^card\d+$/.test(name)); } catch { return gpus; }
  for (const card of cards) {
    const device = join('/sys/class/drm', card, 'device');
    const vendor = readText(join(device, 'vendor'))?.trim();
    if (!/^0x03/.test(readText(join(device, 'class'))?.trim() ?? '')) continue;
    if (vendor === '0x1002') {
      const total = Number(readText(join(device, 'mem_info_vram_total')));
      const used = Number(readText(join(device, 'mem_info_vram_used')));
      if (!Number.isFinite(total) || total <= 0) continue;
      const integrated = isIntegratedAmd(cpuModel, total);
      gpus.push({
        name: integrated ? `${cpuModel.replace(/.*w\/\s*/i, '') || 'AMD integrated graphics'}` : `AMD GPU (${card})`,
        vendor: 'amd', backend: 'vulkan', vramBytes: total,
        ...(Number.isFinite(used) ? { freeVramBytes: Math.max(0, total - used) } : {}),
        unified: integrated, integrated,
      });
    } else if (vendor === '0x8086') {
      // Intel's discrete Arc cards are the exception; llama.cpp's Vulkan
      // build on them is uncommon enough to leave to an explicit choice.
      gpus.push({ name: 'Intel graphics', vendor: 'intel', backend: 'vulkan', vramBytes: 0, unified: true, integrated: true });
    }
  }
  return gpus;
}

function linuxVulkanLoader(): boolean {
  const directories = ['/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib64', '/usr/lib', '/usr/local/lib', '/lib/x86_64-linux-gnu'];
  return directories.some((directory) => existsSync(join(directory, 'libvulkan.so.1')));
}

async function nvidiaGpus(): Promise<GpuInfo[]> {
  const output = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits']);
  return output ? parseNvidiaSmi(output) : [];
}

async function amdToolGpus(): Promise<GpuInfo[]> {
  const rocm = await run('rocm-smi', ['--showmeminfo', 'vram', '--showproductname', '--json']);
  if (rocm) {
    const gpus = parseRocmSmi(rocm);
    if (gpus.length) return gpus;
  }
  const amd = await run('amd-smi', ['metric', '--mem-usage', '--json']);
  return amd ? parseAmdSmi(amd) : [];
}

async function probeLinux(): Promise<Partial<HardwareProfile>> {
  const memory = parseLinuxMeminfo(readText('/proc/meminfo') ?? '');
  const cpuinfo = readText('/proc/cpuinfo') ?? '';
  const cpuModel = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() ?? cpus()[0]?.model ?? '';
  const nvidia = await nvidiaGpus();
  // A vendor tool's figures beat sysfs's; sysfs fills in where there is none.
  const amdTool = await amdToolGpus();
  const sysfs = linuxSysfsGpus(cpuModel).filter((gpu) => gpu.vendor !== 'amd' || !amdTool.length);
  const amd = amdTool.map((gpu) => (isIntegratedAmd(cpuModel, gpu.vramBytes) ? { ...gpu, integrated: true, unified: true } : gpu));
  return {
    cpuModel,
    physicalCores: parseCpuinfoPhysicalCores(cpuinfo),
    totalRamBytes: memory.totalBytes,
    availableRamBytes: memory.availableBytes,
    gpus: [...nvidia, ...amd, ...sysfs],
    vulkanLoader: linuxVulkanLoader(),
  };
}

async function probeMac(): Promise<Partial<HardwareProfile>> {
  const sysctl = async (name: string): Promise<string | undefined> => (await run('sysctl', ['-n', name]))?.trim();
  const cpuModel = (await sysctl('machdep.cpu.brand_string')) ?? cpus()[0]?.model ?? '';
  const totalRamBytes = Number(await sysctl('hw.memsize')) || totalmem();
  const vmStat = await run('vm_stat', []);
  const physical = Number(await sysctl('hw.physicalcpu'));
  return {
    cpuModel,
    physicalCores: physical > 0 ? physical : undefined,
    totalRamBytes,
    availableRamBytes: vmStat ? parseVmStat(vmStat) : undefined,
    gpus: process.arch === 'arm64' ? [appleSiliconGpu(cpuModel, totalRamBytes)] : [],
    vulkanLoader: false,
  };
}

/** One PowerShell call for everything Windows reports; ConvertTo-Json so
 * the parse does not depend on the display language. */
export const WINDOWS_PROBE_SCRIPT = [
  '$os = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory;',
  '$cpu = Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors;',
  '$gpu = Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM;',
  '@{ os = $os; cpu = $cpu; gpu = $gpu } | ConvertTo-Json -Compress -Depth 4',
].join(' ');

async function probeWindows(): Promise<Partial<HardwareProfile>> {
  const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROBE_SCRIPT], 20_000);
  const probe = output ? parseWindowsProbe(output) : undefined;
  const nvidia = await nvidiaGpus();
  // Win32_VideoController's AdapterRAM is a 32-bit field that tops out at
  // 4 GiB, so it only ever names non-NVIDIA cards here, and their memory is
  // left for llama.cpp's own --fit to find.
  const others: GpuInfo[] = (probe?.adapters ?? [])
    .filter((adapter) => !/nvidia/i.test(adapter.name) && !/microsoft basic|remote display/i.test(adapter.name))
    .map((adapter) => {
      const amd = /amd|radeon/i.test(adapter.name);
      const integrated = /intel/i.test(adapter.name) || (amd && isIntegratedAmd(probe?.cpuModel ?? '', adapter.ramBytes ?? 0));
      return {
        name: adapter.name, vendor: amd ? 'amd' : /intel/i.test(adapter.name) ? 'intel' : 'other',
        backend: 'vulkan', vramBytes: adapter.ramBytes ?? 0, unified: integrated, integrated,
      } satisfies GpuInfo;
    });
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  return {
    cpuModel: probe?.cpuModel,
    physicalCores: probe?.physicalCores,
    totalRamBytes: probe?.totalRamBytes,
    availableRamBytes: probe?.availableRamBytes,
    gpus: [...nvidia, ...others],
    vulkanLoader: existsSync(join(system32, 'vulkan-1.dll')),
  };
}

/** Physical cores when the OS would not say: a guess that assumes two
 * threads per core on x64 (SMT is near-universal there) and one on ARM. */
function guessPhysicalCores(logical: number, arch: string): number {
  return arch === 'x64' && logical >= 4 ? Math.max(1, Math.floor(logical / 2)) : logical;
}

export async function probeHardware(): Promise<HardwareProfile> {
  const logicalCores = Math.max(1, cpus().length);
  const found = process.platform === 'linux' ? await probeLinux()
    : process.platform === 'darwin' ? await probeMac()
      : process.platform === 'win32' ? await probeWindows()
        : {};
  const totalRamBytes = found.totalRamBytes ?? totalmem();
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: found.cpuModel || cpus()[0]?.model || 'unknown CPU',
    physicalCores: Math.min(logicalCores, found.physicalCores ?? guessPhysicalCores(logicalCores, process.arch)),
    logicalCores,
    totalRamBytes,
    // os.freemem() is MemFree on Linux -- too low -- but it is the only
    // figure left if the proper one could not be read.
    availableRamBytes: Math.min(totalRamBytes, found.availableRamBytes ?? freemem()),
    gpus: found.gpus ?? [],
    vulkanLoader: found.vulkanLoader ?? false,
  };
}

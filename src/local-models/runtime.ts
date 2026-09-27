/** The inference server: mainline llama.cpp's own prebuilt release, never
 * compiled here, so no compiler or GPU SDK is ever required.
 *
 * One release is pinned. Its assets' SHA-256 values are the digests GitHub
 * publishes for each release asset (`digest` in the releases API), copied
 * when the tag was pinned; a download that does not match is refused. The
 * tag moves only by editing this file, so every user runs the build this
 * code was tested with.
 *
 * Archives are unpacked with the system's `tar`: GNU or BSD tar on Linux
 * and macOS, and the bsdtar Windows 10+ ships as System32\tar.exe, which
 * also reads zip. */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GpuBackend, HardwareProfile } from './hardware.js';
import { downloadVerified, formatBytes, type DownloadProgress } from './download.js';
import { runtimesDir } from './paths.js';
import type { GpuBudget } from './budget.js';

export const LLAMA_CPP_TAG = 'b11194';
/** The commit b11194 was built from, for the record. */
export const LLAMA_CPP_COMMIT = '9f70b2cecd1a9a3f73ac525c47ca22a6ee9a7b69';

export type RuntimeBackend = 'cpu' | GpuBackend;

export interface RuntimeAsset { name: string; sizeBytes: number; sha256: string }

export interface RuntimeBuild {
  key: string;
  platform: NodeJS.Platform;
  arch: string;
  backend: RuntimeBackend;
  asset: RuntimeAsset;
  /** CUDA builds leave the CUDA runtime libraries out; llama.cpp publishes
   * them as a separate archive that unpacks beside the binaries. */
  companion?: RuntimeAsset;
  /** CUDA builds only: the oldest driver whose CUDA version runs them. */
  minDriverMajor?: number;
}

function asset(name: string, sizeBytes: number, sha256: string): RuntimeAsset {
  return { name, sizeBytes, sha256 };
}

export const RUNTIME_BUILDS: readonly RuntimeBuild[] = [
  { key: 'linux-x64-cpu', platform: 'linux', arch: 'x64', backend: 'cpu',
    asset: asset('llama-b11194-bin-ubuntu-x64.tar.gz', 17_014_362, '527c09064f3c89e4b6e1008a641e31903a04ccdd1c69abd0752acbbd4e1905f6') },
  { key: 'linux-x64-vulkan', platform: 'linux', arch: 'x64', backend: 'vulkan',
    asset: asset('llama-b11194-bin-ubuntu-vulkan-x64.tar.gz', 30_955_864, 'e4f8163eaf2e4d45639238a6fbc09f559e4ff5c0e7d612088a282ed128359c5e') },
  { key: 'linux-x64-cuda13', platform: 'linux', arch: 'x64', backend: 'cuda', minDriverMajor: 580,
    asset: asset('llama-b11194-bin-ubuntu-cuda-13.4-x64.tar.gz', 151_252_143, 'd4c637a0c8fd7bdca68d140c9a36cc6038067a7aa29f7b1994f52f2dafede8fd'),
    companion: asset('cudart-llama-b11194-bin-ubuntu-cuda-13.4-x64.tar.gz', 440_236_666, 'df147535ca08a49cb9be1ced3241e0a043dbedc8a0138b847f0c2e09012ac54c') },
  { key: 'linux-x64-cuda12', platform: 'linux', arch: 'x64', backend: 'cuda', minDriverMajor: 525,
    asset: asset('llama-b11194-bin-ubuntu-cuda-12.8-x64.tar.gz', 170_498_826, 'd415b688f353fcb5a387f272a5b6d783b8f09267b3b73e5e8920de6df9bffac9'),
    companion: asset('cudart-llama-b11194-bin-ubuntu-cuda-12.8-x64.tar.gz', 594_377_795, '3ef39066810c3375bd2e30f418a8b7be7042a4e553e69ca0f9d8132c4fba4ca4') },
  { key: 'linux-x64-rocm', platform: 'linux', arch: 'x64', backend: 'rocm',
    asset: asset('llama-b11194-bin-ubuntu-rocm-10.0-x64.tar.gz', 240_223_282, 'b364ae02badfba6feb47931978b06aaf9c939a49f4f31d80290517fd4bacd604') },
  { key: 'linux-arm64-cpu', platform: 'linux', arch: 'arm64', backend: 'cpu',
    asset: asset('llama-b11194-bin-ubuntu-arm64.tar.gz', 13_608_309, '92a8e5bb9f2f16804715fa6876f64691827a54d41d39dca67e2a83aa70f133ce') },
  { key: 'linux-arm64-vulkan', platform: 'linux', arch: 'arm64', backend: 'vulkan',
    asset: asset('llama-b11194-bin-ubuntu-vulkan-arm64.tar.gz', 24_776_725, '1aa413dda941b31f58ff40205dcd9bad200eb569ef82623b8bc3adf8115162ef') },
  { key: 'linux-arm64-cuda13', platform: 'linux', arch: 'arm64', backend: 'cuda', minDriverMajor: 580,
    asset: asset('llama-b11194-bin-ubuntu-cuda-13.4-arm64.tar.gz', 147_066_552, '3eecee705f32e964afb5a25b13d42af81385f9209c404479eb15deb3e567e957'),
    companion: asset('cudart-llama-b11194-bin-ubuntu-cuda-13.4-arm64.tar.gz', 552_521_399, '8096d68b54c2d5043337e6a99bd446df495f0d409202a92ca70ddee8fa29d2ce') },
  { key: 'darwin-arm64-metal', platform: 'darwin', arch: 'arm64', backend: 'metal',
    asset: asset('llama-b11194-bin-macos-arm64.tar.gz', 11_767_333, 'cc5d31e048c1c440149a0aaf25a6e387823511c0f23561ec534a4ec07c14e9e1') },
  { key: 'darwin-x64-cpu', platform: 'darwin', arch: 'x64', backend: 'cpu',
    asset: asset('llama-b11194-bin-macos-x64.tar.gz', 11_250_068, 'fe9b6c1a2856647303b31401b89e9aab320416706c358c3ce4beb71d21b1f37a') },
  { key: 'win32-x64-cpu', platform: 'win32', arch: 'x64', backend: 'cpu',
    asset: asset('llama-b11194-bin-win-cpu-x64.zip', 18_579_455, 'a508189eb974891c6d665b00d7e1eb5f38adc98345ef1f4815d158dabe188edb') },
  { key: 'win32-x64-vulkan', platform: 'win32', arch: 'x64', backend: 'vulkan',
    asset: asset('llama-b11194-bin-win-vulkan-x64.zip', 32_469_369, '2ba6c1f42f571c5e7d309aeae1052b846794003eca4c332b0ce5498b5bcd7305') },
  { key: 'win32-x64-cuda13', platform: 'win32', arch: 'x64', backend: 'cuda', minDriverMajor: 580,
    asset: asset('llama-b11194-bin-win-cuda-13.4-x64.zip', 151_727_000, '54bcbaeece80d2d3096ab47babe88cbb1923e682e16a31557cd1f1b6579a1ca0'),
    companion: asset('cudart-llama-bin-win-cuda-13.4-x64.zip', 423_535_356, '738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668') },
  { key: 'win32-x64-cuda12', platform: 'win32', arch: 'x64', backend: 'cuda', minDriverMajor: 525,
    asset: asset('llama-b11194-bin-win-cuda-12.4-x64.zip', 262_445_663, '419f7436783fe58640a0e2b6bfde5371ab755f23e3ed717c93aa4777f1deed7f'),
    companion: asset('cudart-llama-bin-win-cuda-12.4-x64.zip', 391_443_627, '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6') },
  { key: 'win32-x64-rocm', platform: 'win32', arch: 'x64', backend: 'rocm',
    asset: asset('llama-b11194-bin-win-rocm-10.0-x64.zip', 256_736_852, 'eed04cf34070ac1bf0c25dedda2dcd92fd1685086311cd039e43befd86897647') },
  { key: 'win32-arm64-cpu', platform: 'win32', arch: 'arm64', backend: 'cpu',
    asset: asset('llama-b11194-bin-win-cpu-arm64.zip', 12_051_155, 'ce9602bae7616831ec3863df7d509fb160183c4a784f98345086723b353d9beb') },
];

function driverMajor(version: string | undefined): number {
  return Number(/^(\d+)/.exec(version ?? '')?.[1] ?? 0);
}

/** The build for this machine and the GPU the budget settled on. A GPU
 * backend with no build here (or, for CUDA, a driver too old for every
 * CUDA build) falls back to the CPU build, which always exists for the
 * platforms ClikCode runs on. */
export function selectRuntimeBuild(hardware: Pick<HardwareProfile, 'platform' | 'arch'>, gpu: GpuBudget | undefined): RuntimeBuild | undefined {
  const builds = RUNTIME_BUILDS.filter((build) => build.platform === hardware.platform && build.arch === hardware.arch);
  if (gpu) {
    const driver = Math.min(...gpu.devices.map((device) => driverMajor(device.driverVersion)));
    const match = builds.find((build) => build.backend === gpu.backend && (build.minDriverMajor === undefined || driver >= build.minDriverMajor));
    if (match) return match;
  }
  return builds.find((build) => build.backend === 'cpu' || build.backend === 'metal');
}

export function runtimeDir(build: RuntimeBuild): string {
  return join(runtimesDir(), LLAMA_CPP_TAG, build.key);
}

const SERVER_BINARY = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

async function findFile(directory: string, name: string, depth = 3): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const direct = entries.find((entry) => entry.isFile() && entry.name === name);
  if (direct) return join(directory, direct.name);
  if (depth <= 0) return undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(join(directory, entry.name), name, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function tarCommand(): string {
  // Git for Windows puts a GNU tar on PATH that cannot read zip files.
  return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

function extract(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(tarCommand(), ['-xf', archive, '-C', into], { windowsHide: true, timeout: 10 * 60_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`Could not unpack ${archive}: ${stderr || error.message}`));
      else resolve();
    });
  });
}

export interface InstalledRuntime {
  build: RuntimeBuild;
  serverPath: string;
  /** Directory holding the server and its libraries; added to the
   * library search path when it starts. */
  directory: string;
}

export interface RuntimeProgress { message: string; bytes?: number; totalBytes?: number }

/** The llama-server binary for this build, downloading and unpacking it on
 * first use. The marker file is written last, so an interrupted install is
 * redone rather than trusted. */
export async function ensureRuntime(build: RuntimeBuild, onProgress?: (progress: RuntimeProgress) => void): Promise<InstalledRuntime> {
  const directory = runtimeDir(build);
  const marker = join(directory, 'installed.json');
  const recorded = await readFile(marker, 'utf8').then((text) => JSON.parse(text) as { serverPath?: string }, () => undefined);
  if (recorded?.serverPath && existsSync(recorded.serverPath)) {
    return { build, serverPath: recorded.serverPath, directory: join(recorded.serverPath, '..') };
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const downloads = join(runtimesDir(), LLAMA_CPP_TAG, 'downloads');
  const unpacked = join(directory, 'files');
  await mkdir(unpacked, { recursive: true });
  for (const item of [build.asset, ...(build.companion ? [build.companion] : [])]) {
    const archive = join(downloads, item.name);
    const label = `downloading llama.cpp ${LLAMA_CPP_TAG} (${build.backend}, ${formatBytes(item.sizeBytes)})`;
    onProgress?.({ message: label, bytes: 0, totalBytes: item.sizeBytes });
    await downloadVerified({
      url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_TAG}/${item.name}`,
      destination: archive, sizeBytes: item.sizeBytes, sha256: item.sha256,
      onProgress: (progress: DownloadProgress) => onProgress?.({ message: label, ...progress }),
    });
    await extract(archive, unpacked);
  }
  const serverPath = await findFile(unpacked, SERVER_BINARY);
  if (!serverPath) throw new Error(`llama.cpp ${LLAMA_CPP_TAG} (${build.asset.name}) has no ${SERVER_BINARY}.`);
  // The companion archive unpacks into the top level; the server looks for
  // its libraries beside itself, so they are moved there.
  if (build.companion) await colocateLibraries(unpacked, join(serverPath, '..'));
  if (process.platform !== 'win32' && ((await stat(serverPath)).mode & 0o111) === 0) await chmod(serverPath, 0o755);
  await writeFile(marker, JSON.stringify({ tag: LLAMA_CPP_TAG, build: build.key, serverPath, at: new Date().toISOString() }));
  // The archives are only needed to install; the unpacked copy is kept.
  await rm(downloads, { recursive: true, force: true });
  return { build, serverPath, directory: join(serverPath, '..') };
}

async function colocateLibraries(root: string, serverDirectory: string): Promise<void> {
  if (root === serverDirectory) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(dll|so(\.\d+)*)$/i.test(entry.name) && !existsSync(join(serverDirectory, entry.name))) {
      await rename(join(root, entry.name), join(serverDirectory, entry.name));
    }
  }
}

/** Installing and updating cua-driver without the GitHub REST API.
 *
 * Cua's own updater resolves "latest" through the unauthenticated API (60 requests an hour per address) and failed on
 * it. This does the same job from release download URLs (github.com/<repo>/releases/download/<tag>/<asset>), which
 * are not rate limited that way; the newest version is read from `gh` when it is signed in, else from the version the
 * published installer script names, probing forward for newer releases by asset URL.
 *
 * Layout, the same as Cua's installers (so `cua-driver update` and uninstall keep working on it):
 *   <home>/packages/releases/<version>-<triple>/   one directory per release, kept for rollback
 *   <home>/packages/current                        symlink (junction on Windows) to the active release
 *   ~/.local/bin/cua-driver                        Linux: symlink into current/
 * macOS keeps Cua's .app-in-/Applications layout and the permission identity that goes with it, so there Cua's own
 * installer script does the placing, pinned to the version found here (a pin needs no API call either). */
import { quiet } from '../../runtime/lifecycle-log.js';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rmdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { driverHome, findDriverBinary } from './driver.js';

export const DRIVER_REPO = 'trycua/cua';
const TAG_PREFIX = 'cua-driver-rs-v';
/** Releases Cua withdrew; never selected. Mirrors the installer's own list. */
const WITHDRAWN = new Set(['0.28.3']);
const CHECKSUMS_REQUIRED_FROM = '0.31.0';
const COSIGN_ISSUER = 'https://token.actions.githubusercontent.com';
const KEEP_RELEASES = 3;
const BAKED_SOURCE = `https://raw.githubusercontent.com/${DRIVER_REPO}/main/libs/cua-driver/scripts/_install-rust.sh`;
const OFFICIAL_INSTALLER = 'https://cua.ai/driver/install.sh';

export type DriverTarget = { platform: 'linux' | 'darwin' | 'win32'; label: string; triple: string; binary: string; ext: 'tar.gz' | 'zip' };

/** The release asset family for this machine; undefined where Cua ships none. */
export function driverTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): DriverTarget | undefined {
  const x64 = arch === 'x64', arm = arch === 'arm64';
  if (platform === 'linux' && (x64 || arm)) return { platform, label: x64 ? 'linux-x86_64' : 'linux-arm64', triple: x64 ? 'x86_64-unknown-linux-gnu' : 'aarch64-unknown-linux-gnu', binary: 'cua-driver', ext: 'tar.gz' };
  if (platform === 'win32' && (x64 || arm)) return { platform, label: x64 ? 'windows-x86_64' : 'windows-arm64', triple: x64 ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc', binary: 'cua-driver.exe', ext: 'zip' };
  if (platform === 'darwin' && (x64 || arm)) return { platform, label: x64 ? 'darwin-x86_64' : 'darwin-arm64', triple: x64 ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin', binary: 'cua-driver', ext: 'tar.gz' };
  return undefined;
}

/** The archive to download: the flat binary tarball on Linux, the per-architecture directory zip on Windows (as install.ps1). */
export function assetName(version: string, target: DriverTarget): string {
  return target.platform === 'linux' ? `cua-driver-rs-${version}-${target.label}-binary.tar.gz` : `cua-driver-rs-${version}-${target.label}.${target.ext}`;
}

export const releaseTag = (version: string): string => `${TAG_PREFIX}${version}`;
export const releaseUrl = (version: string, name: string): string => `https://github.com/${DRIVER_REPO}/releases/download/${releaseTag(version)}/${name}`;
export const releaseDirName = (version: string, target: DriverTarget): string => `${version}-${target.triple}`;

const VERSION = /^\d+\.\d+\.\d+$/;
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
export const versionOf = (output: string): string | undefined => output.match(/(\d+\.\d+\.\d+)/)?.[1];

/** "<sha256>  <asset>" lines, bare or inside a Markdown fence (Cua's checksums.txt). */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

type RunResult = { code: number; stdout: string; stderr: string };
export type InstallDeps = {
  fetch: typeof fetch;
  run(command: string, args: string[], options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<RunResult>;
  /** Runs a program with the terminal attached (the macOS installer prints its own progress and prompts). */
  runVisible(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number>;
  log(line: string): void;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  home: string;
  /** Where the visible `cua-driver` link goes (Linux). */
  binDir: string;
};

export async function defaultDeps(log: (line: string) => void): Promise<InstallDeps> {
  const { execFile, spawn } = await import('node:child_process');
  return {
    fetch, log, platform: process.platform, arch: process.arch, env: process.env, home: driverHome(), binDir: join(homedir(), '.local', 'bin'),
    run: (command, args, options) => new Promise((resolve) => execFile(command, args, { timeout: options?.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, env: options?.env ?? process.env }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) + (error && code === 1 && !stderr ? error.message : '') });
    })),
    runVisible: (command, args, env) => new Promise((resolve) => {
      const child = spawn(command, args, { stdio: 'inherit', env });
      child.once('error', () => resolve(1));
      child.once('exit', (code) => resolve(code ?? 1));
    }),
  };
}

async function fetchRetry(deps: InstallDeps, url: string, init?: RequestInit): Promise<Response> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await deps.fetch(url, { redirect: 'follow', ...init });
      if (response.status === 404 || response.ok) return response;
      if (![408, 429].includes(response.status) && response.status < 500) return response;
      last = new Error(`HTTP ${response.status}`);
    } catch (error) { last = error; }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw new Error(`Could not reach ${new URL(url).host}: ${last instanceof Error ? last.message : String(last)}`);
}

async function exists(url: string, deps: InstallDeps): Promise<boolean> {
  try { return (await deps.fetch(url, { method: 'HEAD', redirect: 'follow' })).ok; } catch { return false; }
}

/** The newest stable cua-driver release for this machine, and how it was found. */
export async function latestDriverVersion(deps: InstallDeps, target: DriverTarget): Promise<{ version: string; source: string }> {
  const fromGh = await deps.run('gh', ['release', 'list', '-R', DRIVER_REPO, '--limit', '400', '--exclude-drafts', '--json', 'tagName', '--jq', '.[].tagName'], { timeoutMs: 30_000 });
  if (fromGh.code === 0) {
    const versions = fromGh.stdout.split('\n').map((tag) => tag.trim()).filter((tag) => tag.startsWith(TAG_PREFIX)).map((tag) => tag.slice(TAG_PREFIX.length)).filter((version) => VERSION.test(version) && !WITHDRAWN.has(version));
    const newest = versions.sort(compareVersions).at(-1);
    if (newest) return { version: newest, source: 'gh release list' };
  }
  // No API: the installer script on main names the newest version it was released with; newer ones may already be
  // published, which a request for their asset shows.
  const page = await fetchRetry(deps, BAKED_SOURCE);
  const baked = page.ok ? (await page.text()).match(/CUA_DRIVER_RS_BAKED_VERSION="(\d+\.\d+\.\d+)"/)?.[1] : undefined;
  if (!baked) throw new Error('Could not find the latest cua-driver version (GitHub did not answer). Name one: clikcode computer driver install --version 0.38.0');
  const [major, minor] = baked.split('.').map(Number) as [number, number];
  const candidates: string[] = [];
  for (let m = minor; m <= minor + 3; m++) for (let p = 0; p <= 4; p++) candidates.push(`${major}.${m}.${p}`);
  const ahead = candidates.filter((version) => compareVersions(version, baked) > 0 && !WITHDRAWN.has(version));
  const published = (await Promise.all(ahead.map(async (version) => (await exists(releaseUrl(version, assetName(version, target)), deps)) ? version : undefined))).filter((version): version is string => Boolean(version));
  return { version: [baked, ...published].sort(compareVersions).at(-1)!, source: 'the published installer' };
}

const packagesDir = (deps: InstallDeps): string => join(deps.home, 'packages');

async function linkTarget(path: string): Promise<string | undefined> {
  try { return basename((await readlink(path)).replace(/[\\/]+$/, '')); } catch { return undefined; }
}

/** The release directories on disk for this target, newest version first, and which one is current. */
export async function installedReleases(deps: InstallDeps, target: DriverTarget): Promise<{ versions: Array<{ version: string; dir: string }>; current?: string; previous?: string }> {
  const releases = join(packagesDir(deps), 'releases');
  const names = await readdir(releases).catch(() => [] as string[]);
  const suffix = `-${target.triple}`;
  const versions = names.filter((name) => name.endsWith(suffix) && VERSION.test(name.slice(0, -suffix.length)))
    .map((name) => ({ version: name.slice(0, -suffix.length), dir: join(releases, name) })).sort((a, b) => compareVersions(b.version, a.version));
  const current = await linkTarget(join(packagesDir(deps), 'current'));
  const previous = (await readFile(join(packagesDir(deps), 'clikcode-previous'), 'utf8').catch(() => '')).trim() || undefined;
  return { versions, ...(current ? { current } : {}), ...(previous ? { previous } : {}) };
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), async (source) => { for await (const chunk of source) hash.update(chunk as Buffer); });
  return hash.digest('hex');
}

async function download(deps: InstallDeps, url: string, to: string): Promise<void> {
  const response = await fetchRetry(deps, url);
  if (response.status === 404) throw new Error(`Not found: ${url}`);
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}): ${url}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(to));
}

/** The archive's checksum from the release's own published list; an install without one is refused. */
async function verifyArchive(deps: InstallDeps, version: string, name: string, archive: string, work: string): Promise<void> {
  let sums: Map<string, string> | undefined;
  for (const file of ['SHA256SUMS', 'checksums.txt']) {
    const response = await fetchRetry(deps, releaseUrl(version, file));
    if (response.ok) { sums = parseChecksums(await response.text()); break; }
  }
  const required = compareVersions(version, CHECKSUMS_REQUIRED_FROM) >= 0;
  const expected = sums?.get(name);
  if (!expected) {
    if (required || sums) throw new Error(`Release ${version} does not list a checksum for ${name}; refusing to install it.`);
    throw new Error(`Release ${version} publishes no checksums; refusing to install it unverified. Choose ${CHECKSUMS_REQUIRED_FROM} or newer.`);
  }
  const actual = await sha256(archive);
  if (actual !== expected) throw new Error(`${name} does not match the release's checksum (expected ${expected}, got ${actual}); refusing to install it.`);
  deps.log(`verified ${name} against the release checksums`);
  const bundle = join(work, `${name}.sigstore.json`);
  const response = await fetchRetry(deps, releaseUrl(version, `${name}.sigstore.json`));
  if (!response.ok) { deps.log('no Sigstore signature published for this archive; checksum only'); return; }
  await writeFile(bundle, Buffer.from(await response.arrayBuffer()));
  const cosign = await deps.run('cosign', ['version'], { timeoutMs: 10_000 });
  if (cosign.code !== 0) { deps.log('cosign is not installed, so the Sigstore signature was not checked (the checksum was); install cosign to verify signatures'); return; }
  const verified = await deps.run('cosign', ['verify-blob', '--bundle', bundle, '--certificate-identity', `https://github.com/${DRIVER_REPO}/.github/workflows/cd-rust-cua-driver.yml@refs/tags/${releaseTag(version)}`, '--certificate-oidc-issuer', COSIGN_ISSUER, archive], { timeoutMs: 60_000 });
  if (verified.code !== 0) throw new Error(`The Sigstore signature of ${name} did not verify for ${releaseTag(version)}; refusing to install it.`);
  deps.log(`verified the Sigstore signature of ${name}`);
}

/** Point `<packages>/current` at a release directory: an atomic rename of a fresh symlink, or a junction on Windows. */
async function pointCurrent(deps: InstallDeps, dirName: string): Promise<void> {
  const packages = packagesDir(deps);
  const current = join(packages, 'current');
  const fresh = join(packages, `.current.${process.pid}`);
  await rm(fresh, { recursive: true, force: true });
  if (deps.platform === 'win32') {
    await symlink(join(packages, 'releases', dirName), fresh, 'junction');
    if (await lstat(current).then(() => true, () => false)) await unlink(current).catch(() => rmdir(current)); // removes the junction, not what it points at
    await rename(fresh, current);
    return;
  }
  await symlink(join('releases', dirName), fresh);
  await rename(fresh, current);
}

async function linkVisible(deps: InstallDeps, target: DriverTarget): Promise<string | undefined> {
  if (deps.platform === 'win32') return undefined; // Windows finds it through the junction; ClikCode does not need PATH.
  const link = join(deps.binDir, target.binary);
  const via = join(packagesDir(deps), 'current', target.binary);
  const existing = await lstat(link).catch(quiet('agent/computer/driver-install'));
  if (existing && !existing.isSymbolicLink()) return `${link} is a real file, so it was left alone; ClikCode uses ${via}`;
  await mkdir(deps.binDir, { recursive: true });
  await rm(link, { force: true });
  await symlink(via, link);
  return undefined;
}

async function prune(deps: InstallDeps, target: DriverTarget, keep: ReadonlySet<string>): Promise<void> {
  const { versions } = await installedReleases(deps, target);
  const survivors = new Set([...keep, ...versions.slice(0, KEEP_RELEASES).map((entry) => basename(entry.dir))]);
  for (const entry of versions) if (!survivors.has(basename(entry.dir))) await rm(entry.dir, { recursive: true, force: true });
}

export type InstallResult = { action: 'installed' | 'up-to-date' | 'newer-installed' | 'delegated' | 'rolled-back'; version: string; dir?: string; previous?: string; notes: string[] };

async function runningVersion(deps: InstallDeps, binary: string): Promise<string | undefined> {
  const result = await deps.run(binary, ['--version'], { timeoutMs: 15_000 });
  return result.code === 0 ? versionOf(result.stdout) : undefined;
}

/** macOS: Cua's own installer places the signed app and keeps its permission identity; it is pinned, so no API call. */
async function installViaOfficialScript(deps: InstallDeps, version: string): Promise<InstallResult> {
  const response = await fetchRetry(deps, OFFICIAL_INSTALLER);
  if (!response.ok) throw new Error(`Could not download Cua's installer from ${OFFICIAL_INSTALLER} (HTTP ${response.status}).`);
  const script = await response.text();
  deps.log(`running Cua's macOS installer, pinned to ${version}`);
  const code = await deps.runVisible('/bin/bash', ['-c', script, 'cua-driver-install'], { ...deps.env, CUA_DRIVER_RS_VERSION: version });
  if (code !== 0) throw new Error(`Cua's installer exited with ${code}.`);
  return { action: 'delegated', version, notes: ['Accessibility and Screen Recording must be granted once: run `cua-driver permissions grant`.'] };
}

export async function installDriver(deps: InstallDeps, options: { version?: string; force?: boolean } = {}): Promise<InstallResult> {
  const target = driverTarget(deps.platform, deps.arch);
  if (!target) throw new Error(`Cua ships no cua-driver for ${deps.platform} ${deps.arch}.`);
  let version = options.version?.replace(/^(cua-driver-rs-)?v/, '');
  if (version !== undefined && !VERSION.test(version)) throw new Error('A version looks like 0.38.0.');
  if (version && WITHDRAWN.has(version)) throw new Error(`Cua withdrew ${version}; choose another.`);
  if (!version) {
    const found = await latestDriverVersion(deps, target);
    version = found.version;
    deps.log(`latest cua-driver is ${version} (from ${found.source})`);
  }
  const binary = findDriverBinary(deps.env, deps.platform);
  const installed = binary ? await runningVersion(deps, binary) : undefined;
  if (installed && !options.force) {
    if (installed === version) return { action: 'up-to-date', version, notes: [] };
    if (!options.version && compareVersions(installed, version) > 0) return { action: 'newer-installed', version: installed, notes: [`Installed ${installed} is newer than the newest release found (${version}); nothing to do.`] };
  }
  if (target.platform === 'darwin') return installViaOfficialScript(deps, version);

  const packages = packagesDir(deps);
  const releases = join(packages, 'releases');
  const dirName = releaseDirName(version, target);
  const finalDir = join(releases, dirName);
  await mkdir(releases, { recursive: true });
  const notes: string[] = [];
  const before = await installedReleases(deps, target);
  if (!(await stat(join(finalDir, target.binary)).then(() => true, () => false)) || options.force) {
    const name = assetName(version, target);
    const work = await mkdtemp(join(packages, '.install-'));
    try {
      const archive = join(work, name);
      deps.log(`downloading ${releaseUrl(version, name)}`);
      await download(deps, releaseUrl(version, name), archive);
      await verifyArchive(deps, version, name, archive, work);
      const unpacked = join(work, 'unpacked');
      await mkdir(unpacked);
      const extract = await deps.run('tar', ['-xf', archive, '-C', unpacked], { timeoutMs: 120_000 });
      if (extract.code !== 0) throw new Error(`Could not unpack ${name}: ${extract.stderr.trim().slice(0, 300)}`);
      const root = (await stat(join(unpacked, target.binary)).then(() => true, () => false)) ? unpacked
        : (await Promise.all((await readdir(unpacked)).map(async (entry) => (await stat(join(unpacked, entry, target.binary)).then(() => true, () => false)) ? join(unpacked, entry) : undefined))).find(Boolean);
      if (!root) throw new Error(`${name} does not contain ${target.binary}.`);
      if (target.platform !== 'win32') await chmod(join(root, target.binary), 0o755);
      await rm(finalDir, { recursive: true, force: true });
      await rename(root, finalDir);
    } finally { await rm(work, { recursive: true, force: true }); }
    const running = await runningVersion(deps, join(finalDir, target.binary));
    if (running !== version) {
      await rm(finalDir, { recursive: true, force: true });
      throw new Error(`The downloaded cua-driver did not run as ${version} (it said ${running ?? 'nothing'}); the install was not changed.`);
    }
  } else deps.log(`${dirName} is already unpacked`);

  if (before.current && before.current !== dirName) await writeFile(join(packages, 'clikcode-previous'), `${before.current}\n`);
  await pointCurrent(deps, dirName);
  deps.log(`current -> releases/${dirName}`);
  const visible = await linkVisible(deps, target);
  if (visible) notes.push(visible);
  await prune(deps, target, new Set([dirName, ...(before.current ? [before.current] : [])]));
  notes.push('Restart ClikCode sessions that were using the desktop tool, and any `cua-driver serve` daemon, to run the new version.');
  return { action: 'installed', version, dir: finalDir, ...(before.current && before.current !== dirName ? { previous: before.current } : {}), notes };
}

/** Go back to the release that was current before the last install (Linux and Windows layout). */
export async function rollbackDriver(deps: InstallDeps): Promise<InstallResult> {
  const target = driverTarget(deps.platform, deps.arch);
  if (!target) throw new Error(`Cua ships no cua-driver for ${deps.platform} ${deps.arch}.`);
  if (target.platform === 'darwin') throw new Error('On macOS, roll back by installing the older release: clikcode computer driver install --version <older>.');
  const { versions, current, previous } = await installedReleases(deps, target);
  const wanted = previous && versions.some((entry) => basename(entry.dir) === previous) ? previous
    : versions.map((entry) => basename(entry.dir)).find((name) => name !== current);
  if (!wanted) throw new Error('There is no earlier cua-driver release on disk to go back to.');
  if (current) await writeFile(join(packagesDir(deps), 'clikcode-previous'), `${current}\n`);
  await pointCurrent(deps, wanted);
  await linkVisible(deps, target);
  return { action: 'rolled-back', version: wanted.slice(0, wanted.length - target.triple.length - 1), dir: join(packagesDir(deps), 'releases', wanted), notes: [] };
}

export type DriverStatus = {
  supported: boolean; target?: string; binary?: string; version?: string;
  releases: string[]; current?: string; previous?: string;
  latest?: string; latestSource?: string; latestError?: string; upToDate?: boolean;
};

export async function driverStatus(deps: InstallDeps, options: { checkLatest?: boolean } = {}): Promise<DriverStatus> {
  const target = driverTarget(deps.platform, deps.arch);
  if (!target) return { supported: false, releases: [] };
  const binary = findDriverBinary(deps.env, deps.platform);
  const version = binary ? await runningVersion(deps, binary) : undefined;
  const { versions, current, previous } = await installedReleases(deps, target);
  const status: DriverStatus = {
    supported: true, target: target.triple, ...(binary ? { binary: await realpath(binary).catch(() => binary) } : {}), ...(version ? { version } : {}),
    releases: versions.map((entry) => entry.version), ...(current ? { current } : {}), ...(previous ? { previous } : {}),
  };
  if (options.checkLatest !== false) {
    try {
      const latest = await latestDriverVersion(deps, target);
      status.latest = latest.version; status.latestSource = latest.source;
      if (version) status.upToDate = compareVersions(version, latest.version) >= 0;
    } catch (error) { status.latestError = error instanceof Error ? error.message : String(error); }
  }
  return status;
}

/** The directory holding the bundled GNOME helper of the active release. */
export async function activeReleaseDir(deps: InstallDeps): Promise<string | undefined> {
  const binary = findDriverBinary(deps.env, deps.platform);
  if (!binary) return undefined;
  return dirname(await realpath(binary).catch(() => binary));
}

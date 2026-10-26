import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assetName, compareVersions, defaultDeps, driverStatus, driverTarget, installDriver, latestDriverVersion, parseChecksums, releaseUrl, rollbackDriver,
  type InstallDeps,
} from './driver-install.js';

describe('release naming', () => {
  it('picks the asset family for each OS and architecture', () => {
    const linux = driverTarget('linux', 'x64')!;
    expect(linux).toMatchObject({ label: 'linux-x86_64', triple: 'x86_64-unknown-linux-gnu', binary: 'cua-driver' });
    expect(assetName('0.38.0', linux)).toBe('cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz');
    expect(assetName('0.38.0', driverTarget('linux', 'arm64')!)).toBe('cua-driver-rs-0.38.0-linux-arm64-binary.tar.gz');
    const windows = driverTarget('win32', 'x64')!;
    expect(windows).toMatchObject({ triple: 'x86_64-pc-windows-msvc', binary: 'cua-driver.exe' });
    expect(assetName('0.38.0', windows)).toBe('cua-driver-rs-0.38.0-windows-x86_64.zip');
    expect(driverTarget('darwin', 'arm64')).toMatchObject({ triple: 'aarch64-apple-darwin' });
    expect(driverTarget('freebsd', 'x64')).toBeUndefined();
    expect(driverTarget('linux', 'ia32')).toBeUndefined();
    expect(releaseUrl('0.38.0', 'x.zip')).toBe('https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/x.zip');
  });

  it('reads checksum lists bare or inside a Markdown fence, and orders versions', () => {
    const sums = parseChecksums(`## SHA256 Checksums\n\`\`\`\n${'a'.repeat(64)}  one.tar.gz\n${'B'.repeat(64)} *two.zip\n\`\`\`\n`);
    expect(sums.get('one.tar.gz')).toBe('a'.repeat(64));
    expect(sums.get('two.zip')).toBe('b'.repeat(64));
    expect(compareVersions('0.38.0', '0.9.1')).toBeGreaterThan(0);
    expect(compareVersions('0.38.0', '0.38.0')).toBe(0);
  });
});

const linuxX64 = process.platform === 'linux' && process.arch === 'x64';

describe.skipIf(!linuxX64)('installing cua-driver (Linux layout)', () => {
  let root: string;
  let requested: string[];
  let deps: InstallDeps;
  const target = driverTarget('linux', 'x64')!;
  const archives = new Map<string, { bytes: Buffer; sha: string }>();
  let published: Record<string, string> = {};
  let ghTags = '';

  async function makeArchive(version: string): Promise<void> {
    const stage = await mkdtemp(join(tmpdir(), 'cua-archive-'));
    await writeFile(join(stage, 'cua-driver'), `#!/bin/sh\necho "cua-driver ${version}"\n`, { mode: 0o755 });
    await writeFile(join(stage, 'LICENSE'), 'MIT');
    const file = join(stage, 'a.tar.gz');
    execFileSync('tar', ['-czf', file, '-C', stage, 'cua-driver', 'LICENSE']);
    const bytes = await readFile(file);
    archives.set(assetName(version, target), { bytes, sha: createHash('sha256').update(bytes).digest('hex') });
    await rm(stage, { recursive: true, force: true });
  }

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(`${init?.method ?? 'GET'} ${url}`);
    const asset = decodeURIComponent(url.split('/').pop()!);
    const version = url.match(/cua-driver-rs-v(\d+\.\d+\.\d+)\//)?.[1];
    if (url.includes('_install-rust.sh')) return new Response(`X\nCUA_DRIVER_RS_BAKED_VERSION="${published.baked ?? '0.37.0'}" # published\n`);
    if (version && asset === 'checksums.txt') {
      if (!published[version]) return new Response('no', { status: 404 });
      return new Response(`## SHA256 Checksums\n\`\`\`\n${[...archives].filter(([name]) => name.includes(`-${version}-`)).map(([name, a]) => `${published[`bad-${version}`] ?? a.sha}  ${name}`).join('\n')}\n\`\`\`\n`);
    }
    if (version && archives.has(asset) && published[version]) return new Response(init?.method === 'HEAD' ? null : new Uint8Array(archives.get(asset)!.bytes));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cua-install-'));
    requested = []; published = {}; ghTags = '';
    archives.clear();
    for (const version of ['0.37.0', '0.38.0', '0.38.1']) await makeArchive(version);
    const base = await defaultDeps(() => undefined);
    const home = join(root, 'home'), binDir = join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    deps = {
      ...base, fetch: fakeFetch, platform: 'linux', arch: 'x64', home, binDir, env: { PATH: binDir, CUA_DRIVER_RS_HOME: home },
      run: (command, args, options) => command === 'gh' ? Promise.resolve({ code: ghTags ? 0 : 1, stdout: ghTags, stderr: '' })
        : command === 'cosign' ? Promise.resolve({ code: 1, stdout: '', stderr: 'not installed' }) : base.run(command, args, options),
    };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('finds the newest release without the GitHub API: the installer script names one, newer assets are probed', async () => {
    published = { baked: '0.37.0', '0.37.0': 'y', '0.38.0': 'y' };
    expect(await latestDriverVersion(deps, target)).toEqual({ version: '0.38.0', source: 'the published installer' });
    expect(requested.some((entry) => entry.includes('api.github.com'))).toBe(false);
  });

  it('asks gh first when it is signed in', async () => {
    ghTags = 'cua-driver-rs-v0.38.0\nnightly-cua-driver-rs-v0.38.1-nightly.20261026.1\ncua-driver-rs-v0.9.0\ncua-driver-rs-v0.28.3\ncua-spaces-v0.16.0\n';
    expect(await latestDriverVersion(deps, target)).toEqual({ version: '0.38.0', source: 'gh release list' });
    expect(requested).toEqual([]);
  });

  it('installs a verified release, makes it current and links it on PATH', async () => {
    published = { '0.38.0': 'y' };
    const result = await installDriver(deps, { version: '0.38.0' });
    expect(result).toMatchObject({ action: 'installed', version: '0.38.0' });
    expect(await readlink(join(deps.home, 'packages', 'current'))).toBe(join('releases', '0.38.0-x86_64-unknown-linux-gnu'));
    expect(await readlink(join(deps.binDir, 'cua-driver'))).toBe(join(deps.home, 'packages', 'current', 'cua-driver'));
    expect((await readdir(join(deps.home, 'packages'))).sort()).toEqual(['current', 'releases']);
    expect(requested.some((entry) => entry.includes('api.github.com'))).toBe(false);
    const status = await driverStatus(deps, { checkLatest: false });
    expect(status).toMatchObject({ version: '0.38.0', current: '0.38.0-x86_64-unknown-linux-gnu', releases: ['0.38.0'] });
  });

  it('refuses an archive whose checksum does not match, and changes nothing', async () => {
    published = { '0.38.0': 'y', 'bad-0.38.0': 'f'.repeat(64) };
    await expect(installDriver(deps, { version: '0.38.0' })).rejects.toThrow('does not match');
    await expect(lstat(join(deps.home, 'packages', 'current'))).rejects.toThrow();
    expect(await readdir(join(deps.home, 'packages', 'releases'))).toEqual([]);
    expect((await readdir(join(deps.home, 'packages'))).filter((name) => name.startsWith('.install'))).toEqual([]);
  });

  it('refuses a release that lists no checksum for the archive', async () => {
    published = { '0.38.0': 'y' };
    archives.delete(assetName('0.38.0', target));
    await makeArchive('0.38.0');
    const original = deps.fetch;
    deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => String(input).endsWith('checksums.txt') ? new Response(`${'a'.repeat(64)}  other.tar.gz\n`) : original(input, init)) as typeof fetch;
    await expect(installDriver(deps, { version: '0.38.0' })).rejects.toThrow('does not list a checksum');
  });

  it('updates, keeps the previous release, and rolls back', async () => {
    published = { '0.38.0': 'y', '0.38.1': 'y', baked: '0.38.0' };
    await installDriver(deps, { version: '0.38.0' });
    const update = await installDriver(deps, {});
    expect(update).toMatchObject({ action: 'installed', version: '0.38.1', previous: '0.38.0-x86_64-unknown-linux-gnu' });
    expect(await readlink(join(deps.home, 'packages', 'current'))).toBe(join('releases', '0.38.1-x86_64-unknown-linux-gnu'));
    expect((await readdir(join(deps.home, 'packages', 'releases'))).sort()).toEqual(['0.38.0-x86_64-unknown-linux-gnu', '0.38.1-x86_64-unknown-linux-gnu']);
    expect(await driverStatus(deps, { checkLatest: false })).toMatchObject({ version: '0.38.1', previous: '0.38.0-x86_64-unknown-linux-gnu' });
    expect(await rollbackDriver(deps)).toMatchObject({ action: 'rolled-back', version: '0.38.0' });
    expect((await driverStatus(deps, { checkLatest: false })).version).toBe('0.38.0');
    // And forward again: rollback records where it came from.
    expect(await rollbackDriver(deps)).toMatchObject({ version: '0.38.1' });
  });

  it('says so when it is current, and never downgrades an install that is ahead of the newest release found', async () => {
    published = { '0.38.0': 'y', baked: '0.37.0', '0.37.0': 'y', '0.38.1': 'y' };
    await installDriver(deps, { version: '0.38.1' });
    expect(await installDriver(deps, { version: '0.38.1' })).toMatchObject({ action: 'up-to-date' });
    published = { baked: '0.37.0', '0.37.0': 'y' };
    expect(await installDriver(deps, {})).toMatchObject({ action: 'newer-installed', version: '0.38.1' });
    expect((await driverStatus(deps, { checkLatest: false })).version).toBe('0.38.1');
  });

  it('prunes old releases but keeps the active and the previous one', async () => {
    published = { '0.38.0': 'y', '0.38.1': 'y' };
    for (const version of ['0.37.0', '0.38.0', '0.38.1']) { published[version] = 'y'; await installDriver(deps, { version, force: true }); }
    await mkdir(join(deps.home, 'packages', 'releases', '0.30.0-x86_64-unknown-linux-gnu'));
    await mkdir(join(deps.home, 'packages', 'releases', '0.31.0-x86_64-unknown-linux-gnu'));
    await installDriver(deps, { version: '0.38.1', force: true });
    const left = (await readdir(join(deps.home, 'packages', 'releases'))).sort();
    expect(left).toContain('0.38.1-x86_64-unknown-linux-gnu');
    expect(left).not.toContain('0.30.0-x86_64-unknown-linux-gnu');
    expect(left.length).toBeLessThanOrEqual(3);
  });

  it('leaves a real file at the PATH location alone', async () => {
    published = { '0.38.0': 'y' };
    await writeFile(join(deps.binDir, 'cua-driver'), '#!/bin/sh\necho "cua-driver 0.1.0"\n', { mode: 0o755 });
    const result = await installDriver(deps, { version: '0.38.0', force: true });
    expect(result.notes.join('\n')).toContain('left alone');
    expect(await readFile(join(deps.binDir, 'cua-driver'), 'utf8')).toContain('0.1.0');
  });

  it('refuses a bad version string and a withdrawn release', async () => {
    await expect(installDriver(deps, { version: 'latest' })).rejects.toThrow('looks like');
    await expect(installDriver(deps, { version: '0.28.3' })).rejects.toThrow('withdrew');
  });
});

describe('installing on macOS', () => {
  it('runs Cua\'s own installer pinned to the version found, not the API', async () => {
    const seen: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const urls: string[] = [];
    const base = await defaultDeps(() => undefined);
    const deps: InstallDeps = {
      ...base, platform: 'darwin', arch: 'arm64', env: { PATH: '/nonexistent' }, home: '/nonexistent/.cua-driver',
      fetch: (async (input: string | URL | Request) => { urls.push(String(input)); return new Response('#!/bin/bash\necho installed\n'); }) as typeof fetch,
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: '' }),
      runVisible: (command, args, env) => { seen.push({ command, args, env }); return Promise.resolve(0); },
    };
    const result = await installDriver(deps, { version: '0.38.0' });
    expect(result).toMatchObject({ action: 'delegated', version: '0.38.0' });
    expect(seen[0]!.command).toBe('/bin/bash');
    expect(seen[0]!.env['CUA_DRIVER_RS_VERSION']).toBe('0.38.0');
    expect(urls).toEqual(['https://cua.ai/driver/install.sh']);
    expect(result.notes.join(' ')).toContain('permissions grant');
  });
});

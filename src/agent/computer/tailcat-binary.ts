/** Fetch the pinned official Tailcat CLI on first use; no account or install step. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = 'v0.7.0';
const RELEASE = `https://github.com/tailscale/tailcat/releases/download/${VERSION}`;
const ARCHIVES: Record<string, { name: string; sha256: string; binary: string }> = {
  'linux-x64': { name: 'tailcat_0.7.0_linux_amd64.tar.gz', sha256: '23c0b1887a5ec422f0d18a9c52b4f5357815febdaae738a1eb54036d10bd9ee6', binary: 'tailcat' },
  'linux-arm64': { name: 'tailcat_0.7.0_linux_arm64.tar.gz', sha256: 'bbb1ab50f24f00effe1e1fd86d0501803fb80793a90785a2a16ff3428f03d8ef', binary: 'tailcat' },
  'linux-arm': { name: 'tailcat_0.7.0_linux_armv7.tar.gz', sha256: 'cad3994b1f336b67e8a3a5273a9cecb44331d14d57eb32bfe7d0919adeab22b7', binary: 'tailcat' },
  'win32-x64': { name: 'tailcat_0.7.0_windows_amd64.zip', sha256: 'f04cac07e3bf6c700b0b543df0d3315a3b312cd5a05ee76714e1cc848e9b2dff', binary: 'tailcat.exe' },
  'win32-arm64': { name: 'tailcat_0.7.0_windows_arm64.zip', sha256: '1c2d081375ade2365402f9fcf611e89dbb2c5c5ee06936aaff2b205dbe427578', binary: 'tailcat.exe' },
};
function works(binary: string): boolean {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  return result.status === 0 && /^v(?:0\.(?:[7-9]|[1-9]\d+)|[1-9]\d*\.\d+)\./.test(result.stdout.trim());
}
function extract(archive: string, dir: string, binary: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', [archive.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', dir, binary], { stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(new Error('Could not unpack Tailcat.')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Could not unpack Tailcat.')));
  });
}
export async function tailcatBinary(stateDir: string): Promise<string> {
  const dir = path.join(stateDir, 'computer', 'bin');
  const spec = ARCHIVES[`${process.platform}-${process.arch}`];
  const cached = spec && path.join(dir, `${VERSION}-${spec.binary}`);
  if (cached && works(cached)) return cached;
  if (works('tailcat')) return 'tailcat';
  if (!spec || !cached) throw new Error('Tailcat is not bundled for this computer yet. Install Tailcat and retry the phone handoff.');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `download-${randomUUID()}`);
  await fs.mkdir(temp, { mode: 0o700 });
  try {
    const response = await fetch(`${RELEASE}/${spec.name}`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || Number(response.headers.get('content-length') ?? '0') > 12_000_000) throw new Error('Could not download Tailcat.');
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length > 12_000_000 || createHash('sha256').update(archive).digest('hex') !== spec.sha256) throw new Error('Tailcat download did not match its pinned checksum.');
    const file = path.join(temp, spec.name);
    await fs.writeFile(file, archive, { mode: 0o600 });
    await extract(file, temp, spec.binary);
    const unpacked = path.join(temp, spec.binary);
    if (process.platform !== 'win32') await fs.chmod(unpacked, 0o700);
    if (!works(unpacked)) throw new Error('Tailcat could not start.');
    await fs.rename(unpacked, cached);
    return cached;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

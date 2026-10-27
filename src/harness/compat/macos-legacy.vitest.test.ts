import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activateMacosCompat, compareVersions, prepareMacosCompat, readMachO, runningMacos, stripCodeSignature, type CompatDeps } from './macos-legacy.js';

/** A small 64-bit Intel Mach-O: header, a data segment, __LINKEDIT, LC_BUILD_VERSION and (optionally) the code signature at the very end. */
function machO(options: { minos?: number; signed?: boolean; cpu?: number } = {}): Buffer {
  const { minos = 13 << 16, signed = true, cpu = 0x01000007 } = options;
  const linkeditOffset = 0x4000, linkeditSize = 0x200, signatureSize = 0x300;
  const segment = (name: string, vmsize: number, fileoff: number, filesize: number): Buffer => {
    const cmd = Buffer.alloc(72); cmd.writeUInt32LE(0x19, 0); cmd.writeUInt32LE(72, 4); cmd.write(name, 8, 'latin1');
    cmd.writeBigUInt64LE(BigInt(vmsize), 32); cmd.writeBigUInt64LE(BigInt(fileoff), 40); cmd.writeBigUInt64LE(BigInt(filesize), 48);
    return cmd;
  };
  const build = Buffer.alloc(24); build.writeUInt32LE(0x32, 0); build.writeUInt32LE(24, 4); build.writeUInt32LE(1, 8); build.writeUInt32LE(minos, 12);
  const signature = Buffer.alloc(16); signature.writeUInt32LE(0x1d, 0); signature.writeUInt32LE(16, 4); signature.writeUInt32LE(linkeditOffset + linkeditSize, 8); signature.writeUInt32LE(signatureSize, 12);
  const linkedit = segment('__LINKEDIT', 0x10000, linkeditOffset, linkeditSize + (signed ? signatureSize : 0));
  const commands = [segment('__TEXT', 0x4000, 0, 0x4000), linkedit, build, ...(signed ? [signature] : [])];
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(cpu, 4); header.writeUInt32LE(2, 12);
  header.writeUInt32LE(commands.length, 16); header.writeUInt32LE(commands.reduce((n, c) => n + c.length, 0), 20);
  const file = Buffer.alloc(linkeditOffset + linkeditSize + (signed ? signatureSize : 0), 0x41);
  Buffer.concat([header, ...commands]).copy(file, 0);
  return file;
}

let dir = '';
afterEach(async () => { if (dir) { await rm(dir, { recursive: true, force: true }); dir = ''; } });
const scratch = async (): Promise<string> => { dir = await mkdtemp(join(tmpdir(), 'clikcode-compat-')); return dir; };

describe('reading a program', () => {
  it('finds the macOS a program is built for, and nothing for what is not a thin Intel Mach-O', () => {
    expect(readMachO(machO())?.minMacos).toBe('13.0');
    expect(readMachO(machO({ minos: (12 << 16) | (6 << 8) | 1 }))?.minMacos).toBe('12.6.1');
    expect(readMachO(machO({ cpu: 0x0100000c }))).toBeUndefined();
    expect(readMachO(Buffer.from('#!/bin/sh\necho hi\n'.repeat(8)))).toBeUndefined();
    expect(readMachO(Buffer.alloc(8))).toBeUndefined();
  });

  it('orders versions and names the macOS from the kernel version', () => {
    expect(compareVersions('10.15.8', '13.0')).toBe(-1);
    expect(compareVersions('13.0', '13')).toBe(0);
    expect(compareVersions('14.2', '13.6')).toBe(1);
    expect(runningMacos('19.6.0')).toBe('10.15');
    expect(runningMacos('20.6.0')).toBe('11.0');
    expect(runningMacos('21.6.0')).toBe('12.0');
    expect(runningMacos('22.0.0')).toBe('13.0');
    expect(runningMacos('24.3.0')).toBe('15.0');
    expect(runningMacos('nonsense')).toBeUndefined();
  });
});

describe('removing the code signature', () => {
  it('removes its load command, shortens the segment and ends the file where the signature began', async () => {
    const root = await scratch();
    const file = join(root, 'prog'); await writeFile(file, machO());
    expect(await stripCodeSignature(file)).toBe(true);
    const after = await readFile(file);
    const layout = readMachO(after)!;
    expect(layout.ncmds).toBe(3);
    expect(layout.commands.map(command => command.cmd)).toEqual([0x19, 0x19, 0x32]);
    expect(after.length).toBe(0x4000 + 0x200);
    const linkedit = layout.commands[1]!;
    expect(Number(after.readBigUInt64LE(linkedit.offset + 48))).toBe(0x200);
    expect(Number(after.readBigUInt64LE(linkedit.offset + 32))).toBe(0x10000);
    // The bytes freed at the end of the command area are zero.
    expect(after.subarray(32 + layout.sizeofcmds, 32 + layout.sizeofcmds + 16).every(byte => byte === 0)).toBe(true);
  });

  it('changes nothing in a file without a signature, or with one that is not last', async () => {
    const root = await scratch();
    const unsigned = join(root, 'unsigned'); await writeFile(unsigned, machO({ signed: false }));
    expect(await stripCodeSignature(unsigned)).toBe(false);
    expect((await stat(unsigned)).size).toBe(0x4200);
    const trailing = join(root, 'trailing'); await writeFile(trailing, Buffer.concat([machO(), Buffer.alloc(64)]));
    expect(await stripCodeSignature(trailing)).toBe(false);
    expect((await stat(trailing)).size).toBe(0x4000 + 0x200 + 0x300 + 64);
    const script = join(root, 'script'); await writeFile(script, '#!/bin/sh\n');
    expect(await stripCodeSignature(script)).toBe(false);
  });
});

describe('preparing a program', () => {
  const setup = async (options: { minos?: number; platform?: NodeJS.Platform; arch?: string; macos?: string; library?: boolean } = {}): Promise<{ deps: CompatDeps; original: string }> => {
    const root = await scratch();
    await mkdir(join(root, 'bin'), { recursive: true });
    const original = join(root, 'bin', 'claude'); await writeFile(original, machO(options.minos === undefined ? {} : { minos: options.minos })); await chmod(original, 0o755);
    const library = join(root, 'lib.dylib'); await writeFile(library, 'x');
    return { original, deps: { platform: options.platform ?? 'darwin', arch: options.arch ?? 'x64', macos: options.macos ?? '10.15', find: () => original, library: () => options.library === false ? undefined : library, stateDir: join(root, 'state') } };
  };

  it('makes an unsigned copy and a launcher that loads the library, and leaves the original alone', async () => {
    const { deps, original } = await setup();
    const before = await readFile(original);
    const launch = await prepareMacosCompat('claude', deps);
    expect(launch?.minMacos).toBe('13.0');
    expect(launch?.macos).toBe('10.15');
    expect(await readFile(original)).toEqual(before);
    const script = await readFile(launch!.launcher, 'utf8');
    expect(script).toContain('DYLD_INSERT_LIBRARIES=');
    expect(script).toContain('DYLD_FORCE_FLAT_NAMESPACE=1');
    expect(script).toMatch(/exec '.*claude\.bin' "\$@"/);
    expect((await stat(launch!.launcher)).mode & 0o111).not.toBe(0);
    const copy = script.match(/exec '([^']+)'/)![1]!;
    expect(readMachO(await readFile(copy))?.commands.some(command => command.cmd === 0x1d)).toBe(false);
  });

  it('reuses the copy while the program is unchanged and replaces it when the program is replaced', async () => {
    const { deps, original } = await setup();
    const first = await prepareMacosCompat('claude', deps);
    const copyOf = async (): Promise<string> => (await readFile(first!.launcher, 'utf8')).match(/exec '([^']+)'/)![1]!;
    const firstCopy = await copyOf();
    const marker = (await stat(firstCopy)).mtimeMs;
    await prepareMacosCompat('claude', deps);
    expect((await stat(firstCopy)).mtimeMs).toBe(marker);
    await writeFile(original, machO({ minos: 14 << 16 }));
    const second = await prepareMacosCompat('claude', deps);
    const secondCopy = (await readFile(second!.launcher, 'utf8')).match(/exec '([^']+)'/)![1]!;
    expect(secondCopy).not.toBe(firstCopy);
    expect(await readdir(join(deps.stateDir, 'compat'))).toHaveLength(2); // the copy and bin/
  });

  it('does nothing when the program already runs here, or this is not an old Intel Mac', async () => {
    expect(await prepareMacosCompat('claude', (await setup({ macos: '14.0' })).deps)).toBeUndefined();
    expect(await prepareMacosCompat('claude', (await setup({ minos: 11 << 16, macos: '12.0' })).deps)).toBeUndefined();
    expect(await prepareMacosCompat('claude', (await setup({ platform: 'linux' })).deps)).toBeUndefined();
    expect(await prepareMacosCompat('claude', (await setup({ arch: 'arm64' })).deps)).toBeUndefined();
    expect(await prepareMacosCompat('claude', (await setup({ library: false })).deps)).toBeUndefined();
    const { deps } = await setup();
    expect(await prepareMacosCompat('claude', { ...deps, find: () => undefined })).toBeUndefined();
  });

  it('puts the launcher first on PATH once and points the chat adapter at it', async () => {
    const { deps } = await setup();
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    const launch = await activateMacosCompat(env, deps);
    expect(env.PATH).toBe(`${launch!.directory}:/usr/bin:/bin`);
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe(launch!.launcher);
    await activateMacosCompat(env, deps);
    expect(env.PATH).toBe(`${launch!.directory}:/usr/bin:/bin`);
    const untouched: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    await activateMacosCompat(untouched, { ...deps, macos: '15.0' });
    expect(untouched).toEqual({ PATH: '/usr/bin' });
  });
});

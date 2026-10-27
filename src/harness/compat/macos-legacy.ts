/** Running a vendor program on a Mac older than it was built for.
 *
 * Claude Code ships as one native program built for macOS 13. An Intel Mac that cannot update past 10.15, 11 or 12 (a 2012 to 2016 iMac or
 * MacBook) stops it at launch with the system loader's "Symbol not found ... built for Mac OS X 13.0": a handful of system functions it imports
 * are missing, and nothing else is wrong. This gives it those functions:
 *
 *   1. a copy of the program with its code signature removed (the signature is what stops the system loading anything into it, and the copy
 *      is the user's own, made on their own Mac; the original is never touched);
 *   2. a small library (native/macos-compat) loaded into the copy that supplies the missing functions, from the same system library where the
 *      old one has an equivalent, and as "unsupported" where it has none (number ranges in Intl);
 *   3. a `claude` launcher first on PATH (and `CLAUDE_CODE_EXECUTABLE` for the chat adapter) that starts the copy with the library.
 *
 * Intel only: every Apple Silicon Mac can run macOS 13. Nothing here runs on another system or when the program already runs. Unsupported by
 * the vendor: the library stands in for system functions, so a feature that needs the real ones can fail where a newer Mac would not. */
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_X86_64 = 0x01000007;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;
const HEADER_SIZE = 32;

export interface MachOLayout {
  commands: { cmd: number; size: number; offset: number }[];
  ncmds: number;
  sizeofcmds: number;
  /** "13.0": the oldest macOS the program says it runs on. */
  minMacos?: string;
}

/** The load commands of a thin 64-bit Intel Mach-O, from the start of the file. Undefined for anything else (fat files, other CPUs, scripts). */
export function readMachO(head: Buffer): MachOLayout | undefined {
  if (head.length < HEADER_SIZE || head.readUInt32LE(0) !== MH_MAGIC_64 || head.readUInt32LE(4) !== CPU_TYPE_X86_64) return undefined;
  const ncmds = head.readUInt32LE(16), sizeofcmds = head.readUInt32LE(20);
  if (HEADER_SIZE + sizeofcmds > head.length) return undefined;
  const commands: MachOLayout['commands'] = [];
  let offset = HEADER_SIZE, minMacos: string | undefined;
  for (let index = 0; index < ncmds; index++) {
    if (offset + 8 > HEADER_SIZE + sizeofcmds) return undefined;
    const cmd = head.readUInt32LE(offset), size = head.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > HEADER_SIZE + sizeofcmds) return undefined;
    commands.push({ cmd, size, offset });
    if (cmd === LC_BUILD_VERSION && size >= 16 && head.readUInt32LE(offset + 8) === PLATFORM_MACOS) minMacos = versionText(head.readUInt32LE(offset + 12));
    else if (cmd === LC_VERSION_MIN_MACOSX && size >= 12) minMacos = versionText(head.readUInt32LE(offset + 8));
    offset += size;
  }
  return { commands, ncmds, sizeofcmds, ...(minMacos ? { minMacos } : {}) };
}

/** Mach-O packs a version into 32 bits: 0xXXXXYYZZ is X.Y.Z. */
function versionText(packed: number): string {
  const major = packed >>> 16, minor = (packed >>> 8) & 0xff, patch = packed & 0xff;
  return patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
}

/** -1, 0 or 1. Versions are dotted numbers ("10.15.8", "13.0"). */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** The macOS this is, from the kernel version (Darwin 19 is macOS 10.15, 20 is 11, 21 is 12, 22 is 13): no program to start and no permission to ask. */
export function runningMacos(kernelRelease = release()): string | undefined {
  const major = Number(kernelRelease.split('.')[0]);
  if (!Number.isInteger(major) || major < 9) return undefined;
  return major >= 20 ? `${major - 9}.0` : `10.${major - 4}`;
}

/** Takes the code signature off a copy of a program, in place, the way `codesign --remove-signature` does: the signature's load command is
 * removed, the segment it sat in is shortened, and the file ends where the signature began. Returns false (and changes nothing) for a file
 * that is not a thin Intel Mach-O, has no signature, or has the signature anywhere but the very end. */
export async function stripCodeSignature(file: string): Promise<boolean> {
  const handle = await open(file, 'r+');
  try {
    const { size: fileSize } = await handle.stat();
    const head = Buffer.alloc(Math.min(fileSize, 1 << 16));
    await handle.read(head, 0, head.length, 0);
    const layout = readMachO(head);
    const signature = layout?.commands.find(command => command.cmd === LC_CODE_SIGNATURE);
    if (!layout || !signature || signature.size !== 16) return false;
    const dataoff = head.readUInt32LE(signature.offset + 8), datasize = head.readUInt32LE(signature.offset + 12);
    if (dataoff + datasize !== fileSize) return false;
    const linkedit = layout.commands.find(command => command.cmd === LC_SEGMENT_64 && head.toString('latin1', command.offset + 8, command.offset + 24).replace(/\0+$/, '') === '__LINKEDIT');
    if (!linkedit) return false;
    const editStart = Number(head.readBigUInt64LE(linkedit.offset + 40));
    if (dataoff < editStart) return false;
    // The segment's size in the file now ends where the signature began; its size in memory is left as it was, as the system's own tool leaves it.
    head.writeBigUInt64LE(BigInt(dataoff - editStart), linkedit.offset + 48);
    // The commands after the signature's move up over it, and the freed bytes at the end of the command area are zeroed.
    const end = HEADER_SIZE + layout.sizeofcmds;
    head.copy(head, signature.offset, signature.offset + signature.size, end);
    head.fill(0, end - signature.size, end);
    head.writeUInt32LE(layout.ncmds - 1, 16);
    head.writeUInt32LE(layout.sizeofcmds - signature.size, 20);
    await handle.write(head, 0, end, 0);
    await handle.truncate(dataoff);
    return true;
  } finally { await handle.close(); }
}

export interface CompatDeps {
  platform: NodeJS.Platform;
  arch: string;
  /** The macOS this is ("10.15.8"), or undefined when not known. */
  macos: string | undefined;
  /** Where `claude` is on PATH, or undefined. */
  find: (name: string) => string | undefined;
  /** The library that supplies the missing functions, or undefined when this build has none. */
  library: () => string | undefined;
  stateDir: string;
}

export interface CompatLaunch {
  /** The `claude` that starts the prepared copy: first on PATH while ClikCode runs. */
  launcher: string;
  /** The folder holding it, for PATH. */
  directory: string;
  original: string;
  minMacos: string;
  macos: string;
}

const LIBRARY = 'libclikcode-compat-x64.dylib';

/** Where the library is: next to the program in a build (dist/), or in the repository's native folder when run from source. */
export function compatLibrary(from: string = fileURLToPath(import.meta.url)): string | undefined {
  const here = dirname(from);
  return [join(here, LIBRARY), join(here, '..', '..', '..', 'native', 'macos-compat', LIBRARY)].find(existsSync);
}

export function findOnPath(name: string, path = process.env.PATH ?? ''): string | undefined {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { /* not here, or not runnable */ }
  }
  return undefined;
}

function defaultDeps(stateDir: string): CompatDeps {
  return { platform: platform(), arch: arch(), macos: runningMacos(), find: name => findOnPath(name), library: () => compatLibrary(), stateDir };
}

/** Whether `claude` on this Mac is a program built for a newer macOS than this one, and if so its layout. */
async function tooNew(binary: string, macos: string): Promise<MachOLayout | undefined> {
  const handle = await open(binary, 'r').catch(quiet('harness/compat/macos-legacy'));
  if (!handle) return undefined;
  try {
    const head = Buffer.alloc(1 << 16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const layout = readMachO(head.subarray(0, bytesRead));
    return layout?.minMacos && compareVersions(layout.minMacos, macos) > 0 ? layout : undefined;
  } finally { await handle.close(); }
}

const key = (stats: { size: number; mtimeMs: number }): string => `${stats.size}-${Math.floor(stats.mtimeMs)}`;

/** Makes (or reuses) the prepared copy and its launcher. Undefined when nothing is needed or it cannot be done; never throws. */
export async function prepareMacosCompat(program = 'claude', deps: CompatDeps = defaultDeps(join(process.env.HOME ?? '', '.clikcode'))): Promise<CompatLaunch | undefined> {
  try {
    if (deps.platform !== 'darwin' || deps.arch !== 'x64' || !deps.macos) return undefined;
    const original = deps.find(program);
    if (!original) return undefined;
    const layout = await tooNew(original, deps.macos);
    const library = deps.library();
    if (!layout?.minMacos || !library) return undefined;
    const stats = await stat(original);
    const root = join(deps.stateDir, 'compat');
    const copyDirectory = join(root, `${program}-${key(stats)}`);
    const copy = join(copyDirectory, `${program}.bin`);
    if (!existsSync(copy)) {
      const temporary = `${copyDirectory}.${process.pid}.tmp`;
      await rm(temporary, { recursive: true, force: true });
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      await copyFile(original, join(temporary, `${program}.bin`), constants.COPYFILE_FICLONE);
      await chmod(join(temporary, `${program}.bin`), 0o755);
      if (!await stripCodeSignature(join(temporary, `${program}.bin`))) { await rm(temporary, { recursive: true, force: true }); return undefined; }
      await rename(temporary, copyDirectory).catch(async () => { await rm(temporary, { recursive: true, force: true }); });
      // The copies of earlier versions of the program are of no further use.
      for (const entry of await readdir(root).catch(() => [] as string[])) if (entry.startsWith(`${program}-`) && join(root, entry) !== copyDirectory) await rm(join(root, entry), { recursive: true, force: true }).catch(quiet('harness/compat/macos-legacy'));
    }
    const directory = join(root, 'bin');
    const launcher = join(directory, program);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const script = `#!/bin/sh\n# ClikCode: ${program} on a Mac older than it was built for (see src/harness/compat/macos-legacy.ts).\nDYLD_INSERT_LIBRARIES='${library.replace(/'/g, `'\\''`)}' DYLD_FORCE_FLAT_NAMESPACE=1 exec '${copy.replace(/'/g, `'\\''`)}' "$@"\n`;
    const temporaryLauncher = `${launcher}.${process.pid}.tmp`;
    await writeFile(temporaryLauncher, script, { mode: 0o755 });
    await rename(temporaryLauncher, launcher);
    return { launcher, directory, original, minMacos: layout.minMacos, macos: deps.macos };
  } catch (error) { quiet('harness/compat/macos-legacy')(error); return undefined; }
}

/** Called once as ClikCode starts, before anything starts a vendor program: on a Mac that needs it, `claude` resolves to the launcher for this
 * process and everything it starts, and the chat adapter is told to use it. */
export async function activateMacosCompat(env: NodeJS.ProcessEnv = process.env, deps?: CompatDeps): Promise<CompatLaunch | undefined> {
  if (!deps && (platform() !== 'darwin' || arch() !== 'x64')) return undefined;
  const launch = await prepareMacosCompat('claude', deps);
  if (!launch) return undefined;
  env.PATH = `${launch.directory}${delimiter}${(env.PATH ?? '').split(delimiter).filter(directory => directory !== launch.directory).join(delimiter)}`;
  env.CLAUDE_CODE_EXECUTABLE = launch.launcher;
  lifecycle('compat.macos', { program: 'claude', builtFor: launch.minMacos, running: launch.macos });
  return launch;
}

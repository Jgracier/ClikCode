/** `npx -y <pkg> args…` as `node <its bin> args…`, for what ClikCode writes
 * into a vendor's MCP config.
 *
 * A vendor starts each MCP server once per session and keeps it, and an npx
 * entry is two processes for the life of that session: npm's own (~50 MB,
 * which only waits on its child) and the server. Naming the bin npx already
 * installed runs the same code as one process.
 *
 * Only what npx itself would run is substituted: the npx cache directory
 * made for exactly this package spec (npm records it in `_npx.packages`),
 * or a global install, at a version the spec pins exactly or does not name.
 * A tag or a range (`@latest`, `@^2`) is re-resolved by npx against the
 * registry on each start, so it is left to npx, and so is anything else this
 * cannot match exactly: an unknown flag, a bin npx would choose differently,
 * a bin that is not a Node script. */
import { open, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { McpServerEntry } from './mcp-registry.js';

/** Flags npx takes before the package that change nothing about what runs. */
const NEUTRAL_FLAGS = new Set(['-y', '--yes', '-q', '--quiet']);

export interface NpxSpec { name: string; version?: string; spec: string; rest: readonly string[] }

/** The package an `npx` command line runs, or undefined when it is not
 * plainly one package (`-p`, `-c`, `--package=`…). */
export function parseNpxCommand(target: string, args: readonly string[]): NpxSpec | undefined {
  if (!/^npx(\.cmd)?$/i.test(basename(target))) return undefined;
  let at = 0;
  while (at < args.length && NEUTRAL_FLAGS.has(args[at]!)) at += 1;
  const spec = args[at];
  if (!spec || spec.startsWith('-')) return undefined;
  const match = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@(.+))?$/i.exec(spec);
  if (!match) return undefined;
  return { name: match[1]!, ...(match[2] ? { version: match[2] } : {}), spec, rest: args.slice(at + 1) };
}

interface PackageJson { version?: string; bin?: string | Record<string, string> }

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return undefined; }
}

/** The bin npx would run for this package: its only one, or the one named
 * after the package. */
function chooseBin(name: string, bin: PackageJson['bin']): string | undefined {
  if (typeof bin === 'string') return bin;
  if (!bin || typeof bin !== 'object') return undefined;
  const entries = Object.entries(bin);
  if (entries.length === 1) return entries[0]![1];
  return bin[name.replace(/^@[^/]+\//, '')];
}

async function nodeScript(path: string): Promise<boolean> {
  if (/\.(c|m)?js$/i.test(path)) return true;
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return false;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(128), 0, 128, 0);
    return /^#!.*\bnode\b/.test(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]!);
  } finally {
    await handle.close();
  }
}

/** The bin of the package installed at `packageDir`, when it is the version
 * asked for. */
async function binIn(packageDir: string, wanted: NpxSpec): Promise<string | undefined> {
  const manifest = await readJson<PackageJson>(join(packageDir, 'package.json'));
  if (!manifest) return undefined;
  if (wanted.version !== undefined && manifest.version !== wanted.version) return undefined;
  const relative = chooseBin(wanted.name, manifest.bin);
  if (!relative) return undefined;
  const path = join(packageDir, relative);
  return await nodeScript(path) ? path : undefined;
}

export interface NpxRoots {
  /** npm's cache (`_npx` lives in it). */
  cache: string;
  /** Global `node_modules` directories, in the order npm would use them. */
  globals: readonly string[];
}

/** Where this machine's npm keeps both. */
export async function npxRoots(home = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<NpxRoots> {
  const cache = env.npm_config_cache?.trim()
    || (process.platform === 'win32' && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'npm-cache') : join(home, '.npm'));
  const npmrc = await readFile(join(home, '.npmrc'), 'utf8').catch(() => '');
  const prefix = env.npm_config_prefix?.trim() || /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(npmrc)?.[1]?.replace(/^~(?=\/)/, home);
  const lib = (root: string) => process.platform === 'win32' ? join(root, 'node_modules') : join(root, 'lib', 'node_modules');
  return { cache, globals: [...new Set([...(prefix ? [lib(prefix)] : []), lib(dirname(dirname(process.execPath)))])] };
}

/** The installed bin for an npx entry, or undefined to leave it to npx. */
export async function resolveNpxBin(wanted: NpxSpec, roots: NpxRoots): Promise<string | undefined> {
  // Only an exact version or none: npx resolves a tag or a range again.
  if (wanted.version !== undefined && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(wanted.version)) return undefined;
  const npx = join(roots.cache, '_npx');
  for (const dir of (await readdir(npx).catch(() => [] as string[])).sort()) {
    const recorded = await readJson<{ _npx?: { packages?: unknown } }>(join(npx, dir, 'package.json'));
    const packages = recorded?._npx?.packages;
    if (!Array.isArray(packages) || packages.length !== 1 || packages[0] !== wanted.spec) continue;
    const found = await binIn(join(npx, dir, 'node_modules', wanted.name), wanted);
    if (found) return found;
  }
  for (const root of roots.globals) {
    const found = await binIn(join(root, wanted.name), wanted);
    if (found) return found;
  }
  return undefined;
}

/** `entry` with npx replaced by the bin it would run, or `entry` itself. */
export async function withoutNpx(entry: McpServerEntry, roots: () => Promise<NpxRoots>): Promise<McpServerEntry> {
  const wanted = parseNpxCommand(entry.target, entry.args ?? []);
  if (!wanted) return entry;
  const bin = await resolveNpxBin(wanted, await roots()).catch(() => undefined);
  return bin ? { ...entry, target: 'node', args: [bin, ...wanted.rest] } : entry;
}

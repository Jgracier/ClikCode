/** Which ClikCode the extension runs, and with which Node.js.
 *
 * The user's installed ClikCode, never a copy inside the extension. The
 * terminal and the editor then attach to a conversation's worker as the same
 * build: a worker is retired by any client whose build differs (see
 * src/worker/client.ts), so a bundled copy and an installed one would retire
 * each other's workers on every attach. And a state file written by a newer
 * ClikCode is never read by an older one hiding in the extension.
 *
 * ClikCode is a Node.js program (engines >=22.12). It is run as
 * `<node> <entry>` rather than through the `clikcode` shim, so it always has
 * the IPC channel the bridge talks over (a Windows .cmd shim in between would
 * not pass it on). The Node.js is the `clikcode.nodePath` setting, else `node`
 * on PATH, else VS Code's own Electron as Node (ELECTRON_RUN_AS_NODE) when its
 * Node.js is new enough -- which the worker it spawns then inherits too.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, join } from 'node:path';
import { INSTALL_HELP } from './compat';

export const MINIMUM_NODE = '22.12.0';

export interface Runtime {
  /** The Node.js executable. */
  node: string;
  /** Set on top of the extension host's environment. */
  env: Record<string, string>;
  /** ClikCode's entry script (dist/index.js). */
  entry: string;
  /** How the Node.js was found, for the log. */
  nodeSource: 'setting' | 'path' | 'vscode';
}

export class RuntimeError extends Error {
  constructor(message: string, readonly kind: 'clikcode-missing' | 'node-missing') { super(message); }
}

export interface RuntimeHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  /** process.versions.node of the extension host. */
  hostNodeVersion: string;
  exists(path: string): boolean;
  isFile(path: string): boolean;
  realpath(path: string): string;
  readHead(path: string): string;
  nodeVersion(node: string): Promise<string | undefined>;
}

export const realHost: RuntimeHost = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
  hostNodeVersion: process.versions.node,
  exists: existsSync,
  isFile: (path) => { try { return statSync(path).isFile(); } catch { return false; } },
  realpath: (path) => realpathSync(path),
  readHead: (path) => { try { return readFileSync(path, 'utf8').slice(0, 512); } catch { return ''; } },
  nodeVersion: (node) => new Promise((resolve) => {
    execFile(node, ['-p', 'process.versions.node'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  }),
};

export function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string): number[] => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parse(version), parse(minimum)];
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

/** Every file a PATH lookup of `name` could run, in order. */
export function pathCandidates(name: string, host: Pick<RuntimeHost, 'platform' | 'env'>): string[] {
  const path = host.env.PATH ?? host.env.Path ?? '';
  const extensions = host.platform === 'win32'
    ? (host.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase()).concat([''])
    : [''];
  return path.split(host.platform === 'win32' ? ';' : delimiter).filter(Boolean)
    .flatMap((directory) => extensions.map((ext) => join(directory, `${name}${ext}`)));
}

function which(name: string, host: RuntimeHost): string | undefined {
  return pathCandidates(name, host).find((candidate) => host.isFile(candidate));
}

/** The script behind whatever `clikcode` resolves to: a symlink to
 * dist/index.js (npm on macOS/Linux), a `#!/usr/bin/env node` script, or an
 * npm shim (.cmd/.ps1/sh) beside node_modules/clikcode. */
export function entryFor(candidate: string, host: RuntimeHost): string | undefined {
  let real = candidate;
  try { real = host.realpath(candidate); } catch { /* keep the path as given */ }
  if (['.js', '.mjs', '.cjs'].includes(extname(real).toLowerCase())) return host.isFile(real) ? real : undefined;
  const beside = join(dirname(candidate), 'node_modules', 'clikcode', 'dist', 'index.js');
  if (host.isFile(beside)) return beside;
  if (host.isFile(real) && /^#!.*\bnode\b/.test(host.readHead(real))) return real;
  return undefined;
}

export function resolveEntry(setting: string | undefined, host: RuntimeHost): string {
  const configured = setting?.trim();
  if (configured) {
    const entry = host.exists(configured) ? entryFor(configured, host) : undefined;
    if (!entry) throw new RuntimeError(`clikcode.path is set to "${configured}", which is not a ClikCode installation.`, 'clikcode-missing');
    return entry;
  }
  for (const candidate of pathCandidates('clikcode', host).filter((path) => host.isFile(path))) {
    const entry = entryFor(candidate, host);
    if (entry) return entry;
  }
  throw new RuntimeError(`ClikCode is not installed (no \`clikcode\` on PATH). Install it with: ${INSTALL_HELP}`, 'clikcode-missing');
}

export async function resolveNode(setting: string | undefined, host: RuntimeHost): Promise<Pick<Runtime, 'node' | 'env' | 'nodeSource'>> {
  const configured = setting?.trim();
  if (configured) {
    const version = await host.nodeVersion(configured);
    if (!version) throw new RuntimeError(`clikcode.nodePath "${configured}" could not be run.`, 'node-missing');
    if (!versionAtLeast(version, MINIMUM_NODE)) throw new RuntimeError(`clikcode.nodePath is Node.js ${version}; ClikCode needs ${MINIMUM_NODE} or newer.`, 'node-missing');
    return { node: configured, env: {}, nodeSource: 'setting' };
  }
  const onPath = which('node', host);
  if (onPath) {
    const version = await host.nodeVersion(onPath);
    if (version && versionAtLeast(version, MINIMUM_NODE)) return { node: onPath, env: {}, nodeSource: 'path' };
  }
  if (versionAtLeast(host.hostNodeVersion, MINIMUM_NODE)) {
    return { node: host.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, nodeSource: 'vscode' };
  }
  throw new RuntimeError(`ClikCode needs Node.js ${MINIMUM_NODE} or newer: install it, or set clikcode.nodePath.`, 'node-missing');
}

export async function resolveRuntime(settings: { path?: string; nodePath?: string }, host: RuntimeHost = realHost): Promise<Runtime> {
  const entry = resolveEntry(settings.path, host);
  return { entry, ...(await resolveNode(settings.nodePath, host)) };
}

/** The build a worker records (src/worker/registry.ts currentWorkerBuild):
 * the entry's mtime and size. A reinstall changes it, and the bridge is
 * restarted onto the new build between turns. */
export function entryBuild(entry: string): string | undefined {
  try {
    const stats = statSync(entry);
    return `${Math.round(stats.mtimeMs)}:${stats.size}`;
  } catch {
    return undefined;
  }
}

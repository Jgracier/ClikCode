/** Where an installed harness can be, beyond the PATH ClikCode started with.
 *
 * A vendor installer adds its directory (~/.local/bin, %LOCALAPPDATA%\agy\bin)
 * to a shell profile, which a ClikCode already running -- or started by an
 * editor that read the profile before the install -- never sees. And when
 * npm's global prefix is not writable, ClikCode installs into a prefix of its
 * own that no profile names at all. So both are appended to this process's
 * PATH: every lookup (binaryOnPath) and every spawn of a harness, and of what
 * that harness spawns in turn, then finds them. Appended, never prepended: a
 * binary the user put on PATH themselves still wins. */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiHarnessInstallStep, AiHarnessInstaller } from '../../definition.js';
import { stateDirectory } from '../../../session/store/paths.js';

/** The npm prefix ClikCode installs into when the global one is not
 * writable: under ClikCode's own state directory, so it needs no sudo and
 * goes wherever CLIKCODE_HOME does. */
export function managedNpmPrefix(): string {
  return join(stateDirectory(), 'tools', 'npm');
}

/** Where `npm install --global --prefix <prefix>` puts executables: npm
 * writes the .cmd shims straight into the prefix on Windows. */
export function npmPrefixBinDir(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? prefix : join(prefix, 'bin');
}

/** The installer step for this OS, if the vendor ships one. */
export function installStepFor(installer: AiHarnessInstaller | undefined, platform: NodeJS.Platform = process.platform): AiHarnessInstallStep | undefined {
  return platform === 'win32' ? installer?.windows : installer?.posix;
}

/** `~/…` and `${NAME}/…` as a real path. Undefined when the variable is
 * unset: a directory that cannot be named is not searched. */
export function expandInstallDir(dir: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  let unresolved = false;
  const expanded = dir.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = env[name] ?? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (!value) unresolved = true;
    return value ?? '';
  });
  if (unresolved) return undefined;
  if (expanded === '~') return home;
  if (expanded.startsWith('~/')) return join(home, expanded.slice(2));
  return expanded;
}

interface InstallableHarness { installer?: AiHarnessInstaller }

/** Every directory a catalog harness can be installed into on this OS, then
 * ClikCode's own npm prefix. */
export function harnessInstallDirs(
  harnesses: readonly InstallableHarness[],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const dirs = new Set<string>();
  for (const harness of harnesses) {
    for (const dir of installStepFor(harness.installer, platform)?.binDirs ?? []) {
      const expanded = expandInstallDir(dir, options.env, options.home);
      if (expanded) dirs.add(expanded);
    }
  }
  dirs.add(npmPrefixBinDir(managedNpmPrefix(), platform));
  return [...dirs];
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

/** `pathValue` with each of `dirs` not already on it appended. */
export function withPathDirs(pathValue: string, dirs: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const separator = platform === 'win32' ? ';' : ':';
  const normalize = (dir: string): string => {
    const trimmed = dir.replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  const entries = pathValue ? pathValue.split(separator) : [];
  const present = new Set(entries.map(normalize));
  for (const dir of dirs) {
    if (!dir || present.has(normalize(dir))) continue;
    entries.push(dir);
    present.add(normalize(dir));
  }
  return entries.join(separator);
}

/** Append directories to this process's PATH (and so every child's). */
export function addToProcessPath(dirs: readonly string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  const key = pathKey(env);
  env[key] = withPathDirs(env[key] ?? '', dirs, platform);
}

let augmented = false;

/** Once per process, when the catalog is first read: every declared install
 * directory and ClikCode's npm prefix go on the end of PATH. */
export function augmentProcessPath(harnesses: readonly InstallableHarness[]): void {
  if (augmented) return;
  augmented = true;
  addToProcessPath(harnessInstallDirs(harnesses));
}

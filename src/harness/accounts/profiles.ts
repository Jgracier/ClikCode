/** The per-account profile directory a vendor CLI is pointed at, and the
 * rules for removing one safely. */

import { existsSync } from 'node:fs';
import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { homeRedirectEnvironment } from '../../runtime/lazy-bridge.js';
import { harnessStatePath } from '../../session/state/paths.js';
import { readState } from '../../session/state/read.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';

/** The environment a vendor process runs under for this account: its isolated
 * profile root, plus -- when that root IS `HOME` -- the user's real git, npm,
 * gh, docker and gpg configuration (catalog HOME_REDIRECT_ENV_DEFAULTS), so a
 * turn can still commit, push and install as the user. SSH_AUTH_SOCK and
 * GIT_SSH_COMMAND are inherited from the caller's environment unchanged. XDG_*
 * is deliberately left alone: pointing XDG_CONFIG_HOME at the real home would
 * hand a HOME-isolated CLI the shared config its isolation exists to avoid. */
export function profileEnvironment(
  harness: AiLocalHarnessDefinition, account: Pick<AiHarnessAccount, 'nativeProfile'> | undefined,
): Record<string, string> {
  return homeRedirectEnvironment(harness, nativeProfileEnvironment(account?.nativeProfile), { home: homedir(), exists: existsSync });
}

/** Root of every profile directory ClikCode itself created. Nothing outside it
 * is ever deleted by account removal or garbage collection. */
function clikcodeProfilesRoot(): string {
  return resolve(join(harnessStatePath(), '..', 'profiles'));
}

/** Resolves `profilePath` to a directory that is safe to delete, or explains
 * why it is not. Safe means: lexically `<root>/<harness>/<profile>` exactly, a
 * real directory (not a symlink), and still inside the root once every symlink
 * on the way is resolved. */
export async function resolvePurgeableProfile(profilePath: string): Promise<{ path: string } | { refused: string }> {
  const root = clikcodeProfilesRoot();
  const target = resolve(profilePath);
  const inside = relative(root, target);
  if (!inside || inside.startsWith('..') || resolve(root, inside) !== target) return { refused: 'outside the ClikCode profiles directory' };
  const segments = inside.split(sep);
  if (segments.length !== 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return { refused: 'not a <harness>/<profile> directory' };
  }
  let info;
  try { info = await lstat(target); } catch { return { refused: 'already gone' }; }
  if (info.isSymbolicLink()) return { refused: 'a symbolic link' };
  if (!info.isDirectory()) return { refused: 'not a directory' };
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (realTarget !== join(realRoot, ...segments)) return { refused: 'resolves outside the ClikCode profiles directory' };
  } catch {
    return { refused: 'could not be resolved' };
  }
  return { path: target };
}

/** Deletes an account's ClikCode-created profile directory (vendor credentials
 * included). Refuses anything outside the profiles root and anything another
 * account still points at. Returns the removed path, if any. */
export async function purgeAccountProfile(
  account: Pick<AiHarnessAccount, 'nativeProfile'>, remainingAccounts: readonly AiHarnessAccount[],
): Promise<string | undefined> {
  const profilePath = account.nativeProfile?.path;
  if (!profilePath) return undefined;
  const target = resolve(profilePath);
  if (remainingAccounts.some((other) => other.nativeProfile?.path && resolve(other.nativeProfile.path) === target)) return undefined;
  const verdict = await resolvePurgeableProfile(profilePath);
  if ('refused' in verdict) return undefined;
  await rm(verdict.path, { recursive: true, force: true });
  return verdict.path;
}

/** Profile directories no account refers to: abandoned logins, accounts removed
 * by a build that did not purge, profiles replaced by a re-login. A directory
 * younger than `minAgeMs` is left alone -- a login in progress has created its
 * directory but not yet saved its account. */
async function collectOrphanProfiles(options: { dryRun?: boolean; minAgeMs?: number; now?: number } = {}): Promise<{ removed: string[]; kept: string[] }> {
  const minAgeMs = options.minAgeMs ?? 60 * 60_000;
  const now = options.now ?? Date.now();
  const root = clikcodeProfilesRoot();
  const state = await readState();
  const referenced = new Set(state.accounts.flatMap((account) => account.nativeProfile?.path ? [resolve(account.nativeProfile.path)] : []));
  const removed: string[] = [];
  const kept: string[] = [];
  const list = async (directory: string): Promise<string[]> => {
    try { return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch {
      // fail-open-ok: no profiles directory means there is nothing to collect.
      return [];
    }
  };
  for (const harnessName of await list(root)) {
    for (const profileName of await list(join(root, harnessName))) {
      const candidate = join(root, harnessName, profileName);
      const verdict = await resolvePurgeableProfile(candidate);
      const info = 'path' in verdict ? await stat(verdict.path).catch(() => undefined) : undefined;
      if (referenced.has(resolve(candidate)) || !('path' in verdict) || !info || now - info.mtimeMs < minAgeMs) {
        kept.push(candidate);
        continue;
      }
      if (!options.dryRun) await rm(verdict.path, { recursive: true, force: true });
      removed.push(verdict.path);
    }
  }
  return { removed, kept };
}

/** The per-account profile directory a vendor CLI is pointed at, and the
 * rules for removing one safely. */

import { existsSync } from 'node:fs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { homeRedirectEnvironment } from '../../runtime/lazy-bridge.js';
import { harnessStatePath } from '../../session/state/paths.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';

/** The environment a vendor process runs under for this account: its isolated
 * profile root, plus -- when that root IS `HOME` -- the user's real git, npm,
 * gh, docker and gpg configuration (catalog HOME_REDIRECT_ENV_DEFAULTS), so a
 * turn can still commit, push and install as the user. SSH_AUTH_SOCK and
 * GIT_SSH_COMMAND are inherited unchanged. XDG paths remain within the
 * account profile to avoid exposing shared CLI configuration. */
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

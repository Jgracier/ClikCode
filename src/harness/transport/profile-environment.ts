/** The environment a vendor CLI is spawned with, per account profile. */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../../session/store/paths.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';
import { readProfileKey } from '../accounts/profile-key.js';

/** Copilot with no sign-in of its own asks `gh auth token --hostname
 * github.com` and runs as the GitHub CLI's user -- verified on copilot 1.0.87:
 * an empty COPILOT_HOME reported `authType: "gh-cli"` and that user's quota.
 * Inside an account profile that silently made every added account the same
 * one, sharing its usage. This `gh` refuses only `auth token` and hands every
 * other command to the real gh further along PATH. */
const COPILOT_GH_SHIM = `#!/bin/sh
# ClikCode: a Copilot account profile signs in on its own, never as gh's user.
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then exit 1; fi
here=$(cd "$(dirname "$0")" && pwd)
PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$here" | paste -sd: -)
exec gh "$@"
`;

function copilotGhShimDirectory(): string | undefined {
  const directory = join(stateDirectory(), 'tools', 'copilot-gh-shim');
  const file = join(directory, 'gh');
  try {
    if (!existsSync(file)) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, COPILOT_GH_SHIM);
      chmodSync(file, 0o755);
    }
    return directory;
  } catch { return undefined; } // fail-open-ok: no shim leaves Copilot as it was, not broken
}

/** What a new account profile adds to its environment beyond the profile
 * root (the catalog's profileExtraEnv), with `{profile}/...` resolved under
 * that profile's path. Undefined when the harness declares nothing. */
export function profileExtraEnvironment(harness: AiLocalHarnessDefinition, profilePath: string): Record<string, string> | undefined {
  const declared = Object.entries(harness.profileExtraEnv ?? {});
  if (!declared.length) return undefined;
  return Object.fromEntries(declared.map(([name, value]) => [name, value.startsWith('{profile}/') ? join(profilePath, value.slice('{profile}/'.length)) : value]));
}

/** The one place that turns an account's nativeProfile into an actual
 * environment object -- every call site used to build `{ [env]: path }`
 * directly, nine of them, which meant nativeProfile.extraEnv (needed only
 * for Antigravity's ADC-based isolation) would have had to be added to all
 * nine individually, with a real risk of missing one and silently falling
 * back to shared, unisolated auth for just that one call path. */
export function nativeProfileEnvironment(
  nativeProfile: AiHarnessAccount['nativeProfile'], platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (!nativeProfile) return {};
  const profileHome = nativeProfile.env === 'HOME' ? nativeProfile.path : undefined;
  return {
    [nativeProfile.env]: nativeProfile.path,
    ...(profileHome ? {
      XDG_CONFIG_HOME: `${profileHome}/.config`,
      XDG_DATA_HOME: `${profileHome}/.local/share`,
      XDG_STATE_HOME: `${profileHome}/.local/state`,
    } : {}),
    ...(platform === 'win32' && profileHome ? {
      USERPROFILE: profileHome,
      APPDATA: `${profileHome}/AppData/Roaming`,
      LOCALAPPDATA: `${profileHome}/AppData/Local`,
    } : {}),
    ...nativeProfile.extraEnv,
    ...copilotProfileEnvironment(nativeProfile, platform),
    // A key pasted at sign-in (profile-key.ts), as the vendor's variable.
    ...readProfileKey(nativeProfile.path),
  };
}

function copilotProfileEnvironment(nativeProfile: NonNullable<AiHarnessAccount['nativeProfile']>, platform: NodeJS.Platform): Record<string, string> {
  if (nativeProfile.env !== 'COPILOT_HOME' || platform === 'win32') return {};
  const shim = copilotGhShimDirectory();
  return shim ? { PATH: [shim, process.env.PATH].filter(Boolean).join(':') } : {};
}

/** Environment for one account. API-key references stay in the parent
 * process, but a CLI can see many exported keys at once; mask the other keys
 * declared by this harness so selection is deterministic. */
export function nativeAccountEnvironment(
  harness: Pick<AiLocalHarnessDefinition, 'authEnv'>,
  account: Pick<AiHarnessAccount, 'nativeProfile' | 'authKind' | 'credentialRef'> | undefined,
): Record<string, string> {
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  if (account?.authKind !== 'api-key' || !account.credentialRef.startsWith('env:')) return environment;
  const selected = account.credentialRef.slice(4);
  if (!/^[A-Z][A-Z0-9_]*$/.test(selected)) return environment;
  for (const name of harness.authEnv ?? []) {
    if (name !== selected) environment[name] = '';
  }
  return environment;
}

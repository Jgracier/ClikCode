/** The environment a vendor CLI is spawned with, per account profile. */

import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';

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
  };
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

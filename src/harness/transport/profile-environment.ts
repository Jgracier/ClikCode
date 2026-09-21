/** The environment a vendor CLI is spawned with, per account profile. */

import type { AiHarnessAccount } from '../definition.js';

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
  return {
    [nativeProfile.env]: nativeProfile.path,
    ...(platform === 'win32' && nativeProfile.env === 'HOME' ? { USERPROFILE: nativeProfile.path } : {}),
    ...nativeProfile.extraEnv,
  };
}

/** The environment a vendor CLI is spawned with, per account profile. */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../../session/store/paths.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';
import { keyVariables, readProfileKey } from '../accounts/profile-key.js';

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
 * root (the catalog's profileExtraEnv), with `{profile}` resolved to that
 * profile's path wherever it appears (`{profile}/adc.json`, and Junie's
 * `-Duser.home={profile}`). Undefined when the harness declares nothing. */
export function profileExtraEnvironment(harness: AiLocalHarnessDefinition, profilePath: string): Record<string, string> | undefined {
  const declared = Object.entries(harness.profileExtraEnv ?? {});
  if (!declared.length) return undefined;
  return Object.fromEntries(declared.map(([name, value]) => [name, value.startsWith('{profile}/')
    ? join(profilePath, value.slice('{profile}/'.length))
    : value.split('{profile}').join(profilePath)]));
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
      // The profile is the vendor's home, not ClikCode's: a `clikcode` the
      // harness runs still reads this install's accounts and chats.
      CLIKCODE_HOME: stateDirectory(),
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
  if (nativeProfile.env !== 'COPILOT_HOME') return {};
  // Copilot accepts these before consulting its profile. A token inherited
  // from ClikCode would silently sign a new profile in as the parent account
  // and could override that profile's identity on later turns too.
  const isolated = { COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
  if (platform === 'win32') return isolated;
  const shim = copilotGhShimDirectory();
  return shim ? { ...isolated, PATH: [shim, process.env.PATH].filter(Boolean).join(':') } : isolated;
}

/** Environment for one account. Every spawn copies ClikCode's own
 * environment, so a key the user exported (ANTHROPIC_API_KEY, XAI_API_KEY...)
 * would reach every vendor process: an account signed in through the
 * vendor's own login, in its own profile, would silently run on that key
 * instead. Such an account sees none of the harness's key variables except
 * one pasted into its profile; an API-key account sees only the one it
 * names. An account with no profile is the user's own vendor setup and
 * keeps the user's environment as it is. */
export function nativeAccountEnvironment(
  harness: Pick<AiLocalHarnessDefinition, 'authEnv' | 'provider'>,
  account: Pick<AiHarnessAccount, 'nativeProfile' | 'authKind' | 'credentialRef'> | undefined,
): Record<string, string> {
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  if (!account) return environment;
  let selected: string | undefined;
  if (account.authKind === 'api-key') {
    if (!account.credentialRef.startsWith('env:')) return environment;
    selected = account.credentialRef.slice(4);
    if (!/^[A-Z][A-Z0-9_]*$/.test(selected)) return environment;
  } else if (!account.nativeProfile) return environment;
  for (const name of keyVariables(harness)) {
    if (name !== selected && !(name in environment)) environment[name] = '';
  }
  return environment;
}

/** Variables that would move a vendor CLI off the signed-in subscription: an
 * API key or bearer token (billed per call), a different endpoint or proxy,
 * or a cloud-provider route (Bedrock, Vertex, Foundry) billed to that cloud.
 * Read from the claude and codex command lines' own documented settings. */
export const SUBSCRIPTION_SCRUBBED_VARIABLES: readonly string[] = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  // Another account's long-lived token (claude setup-token), e.g. a parent Claude Code's: it outranks the profile's sign-in.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT',
  'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
];

/** The environment for a headless vendor CLI turn that must run on the
 * account's signed-in subscription and nothing else (captcha voters,
 * `clikcode agent run`): the parent's environment plus the account profile,
 * with every variable that would bill an API key or route elsewhere removed
 * -- including a key pasted into the profile, since that is per-call usage
 * too. The one place this list lives; spawn sites must not hand-roll it. */
export function subscriptionCliEnvironment(
  nativeProfile: AiHarnessAccount['nativeProfile'], base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base, ...nativeProfileEnvironment(nativeProfile) };
  for (const name of SUBSCRIPTION_SCRUBBED_VARIABLES) delete environment[name];
  return environment;
}

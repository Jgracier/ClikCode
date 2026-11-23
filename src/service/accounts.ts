/** The accounts service's view of providers and accounts: ClikCode's own
 * registry (session state's `accounts`, one profile each under
 * <home>/profiles/<harness>/<id>/) and catalog, said in the service API's
 * words. Pure: what is read, and from where, is service/backend.ts. */
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { UsageWindow } from '../harness/accounts/usage-reading.js';

export type LoginKind = 'device' | 'url-code' | 'api-key';

export interface ServiceProvider {
  provider: string;
  harness: string;
  name: string;
  loginKinds: LoginKind[];
  installed: boolean;
}

export type AccountStatus = 'connected' | 'needs-login' | 'expired' | 'revoked' | 'limited' | 'unknown';

export interface ServiceAccount {
  id: string;
  provider: string;
  harness: string;
  label: string;
  status: AccountStatus;
  detail?: string;
  checkedAt?: string;
  models?: string[];
  usage?: { window?: string; remainingPct?: number; resetsAt?: string };
}

/** How a harness's own login can be finished with no terminal and no
 * browser on this machine: its device sign-in (a code approved anywhere),
 * its link with a code pasted back, a key pasted in. Empty: it cannot. */
export function loginKinds(harness: Pick<AiLocalHarnessDefinition, 'loginArgv' | 'loginRemoteArgv' | 'loginKeyCommand' | 'loginKeyRoutes' | 'localAuth' | 'authEnv'>): LoginKind[] {
  const kinds = new Set<LoginKind>();
  const device = (argv: readonly string[] | undefined): boolean => Boolean(argv?.some((part) => /device/i.test(part)));
  if (harness.loginRemoteArgv?.length || device(harness.loginArgv)) kinds.add('device');
  else if (harness.loginArgv !== undefined && !harness.loginKeyCommand) kinds.add('url-code');
  if (harness.loginKeyCommand || harness.loginKeyRoutes?.length || (harness.localAuth.includes('api-key') && (harness.authEnv?.length ?? 0) > 0)) kinds.add('api-key');
  return [...kinds];
}

/** Every provider ClikCode can sign in to headlessly and run a turn on. */
export function serviceProviders(
  harnesses: readonly AiLocalHarnessDefinition[], canRunTurns: (harness: AiLocalHarnessDefinition) => boolean, installed: (harness: AiLocalHarnessDefinition) => boolean,
): ServiceProvider[] {
  return harnesses.filter((harness) => canRunTurns(harness) && (harness.loginArgv !== undefined || harness.loginKeyCommand))
    .map((harness) => ({ provider: harness.provider, harness: harness.command, name: harness.displayName, loginKinds: loginKinds(harness), installed: installed(harness) }))
    .filter((provider) => provider.loginKinds.length > 0);
}

export interface AccountFacts {
  harness?: string;
  /** Recorded as signed in, but its credential is gone from its profile. */
  signedOutOnDisk: boolean;
  /** accountCanTakeTurn: signed in, verified, usage left. */
  canTakeTurn: boolean;
  /** When an account out of usage is back (accountBackAt). */
  backAt?: string;
  windows?: readonly UsageWindow[];
  usageLabel?: string;
}

/** One account, as the service API says it. */
export function serviceAccountView(account: AiHarnessAccount, facts: AccountFacts): ServiceAccount {
  const base = {
    id: account.id, provider: account.provider, harness: facts.harness ?? account.provider, label: account.label,
    ...(account.usageCheckedAt ?? account.usage?.at ? { checkedAt: account.usageCheckedAt ?? account.usage!.at } : {}),
    ...(account.models.length ? { models: [...account.models] } : {}),
  };
  const usage = usageSummary(facts.windows, facts.backAt);
  const withUsage = usage ? { usage } : {};
  if (!facts.harness) return { ...base, status: 'unknown', detail: `${account.provider} is no longer a supported tool` };
  if (account.status === 'needs_login' || facts.signedOutOnDisk) {
    return { ...base, status: 'needs-login', ...(account.neverSignedIn ? { detail: 'never signed in' } : facts.signedOutOnDisk ? { detail: 'its sign-in is gone from its profile' } : {}) };
  }
  if (account.status === 'offline') return { ...base, status: 'unknown', detail: 'offline', ...withUsage };
  if (account.verification) {
    return { ...base, status: 'revoked', detail: `the vendor will not serve this account until it is verified${account.verification.url ? `: ${account.verification.url}` : ''}`, ...withUsage };
  }
  if (!facts.canTakeTurn) return { ...base, status: 'limited', detail: facts.usageLabel ?? 'out of usage', ...withUsage };
  return { ...base, status: 'connected', ...(facts.usageLabel ? { detail: facts.usageLabel } : {}), ...withUsage };
}

/** The window nearest its limit (the one that stops the account first). */
export function usageSummary(windows: readonly UsageWindow[] | undefined, backAt?: string): ServiceAccount['usage'] | undefined {
  const binding = [...(windows ?? [])].filter((window) => !window.advisory).sort((left, right) => right.usedPct - left.usedPct)[0];
  if (!binding && !backAt) return undefined;
  return {
    ...(binding ? { window: binding.name, remainingPct: Math.max(0, Math.min(100, Math.round(100 - binding.usedPct))) } : {}),
    ...(backAt ?? binding?.resetsAt ? { resetsAt: backAt ?? binding!.resetsAt } : {}),
  };
}

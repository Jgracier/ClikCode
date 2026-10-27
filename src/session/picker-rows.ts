/** The pickers' rows as data, for the terminal and the editor alike.
 *
 * Which providers are listed and how each stands (installed, installs when
 * chosen, signed in), what an account's problem and actions are, which
 * effort levels a chat offers, and what an account's usage reads: decided
 * here once. The terminal's pickers (session/options.ts) and the editor's
 * screens (ide/queries.ts) only format these rows -- before, each decided
 * them itself, and the copies had drifted apart.
 */
import type Conf from 'conf';
import { getApiKeyForUrl, getApiUrl } from '../gateway/credentials.js';
import { gatewayEffort, GATEWAY_EFFORTS } from '../gateway/options.js';
import { inspectNativeHarnessForPicker } from '../harness/transport/native/inspect.js';
import { harnessInstallRoute } from '../harness/transport/native/install-route.js';
import { authEvidencePresent, hasAuthEvidence, harnessCanLogout } from '../harness/accounts/auth-files.js';
import { effortChoicesFor } from '../harness/accounts/effort-choices.js';
import { accountBackAt, accountDisplayUsage, quotaRefusalHolds, usageReadingIsCurrent, type AccountUsageReading, type UsageWindow } from '../harness/accounts/usage-reading.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import {
  allLocalHarnesses, harnessCanRunTurns, harnessSupportsEffort, harnessSupportsModelSelection, localHarnessForCommand,
} from '../runtime/lazy-bridge.js';
import type { IdeAccount, IdeProvider } from '../ide/protocol.js';
import type { HarnessSession, HarnessState } from './model.js';
import { GATEWAY_LABEL, isClikCodeAgent, isGatewayService } from './route.js';
import { compareProviders, integrationLabel } from './options.js';

export const GATEWAY_ID = 'gateway';
export const LOCAL_ID = 'clikcode-local';

/** Signed in to a harness: one of its accounts is ready, or (installed) the
 * vendor keeps a credential on disk. Running out of usage is not signing
 * out: a spent account is still signed in, and says so as its own problem. */
export async function harnessSignedIn(harness: AiLocalHarnessDefinition, accounts: readonly AiHarnessAccount[], installed: boolean): Promise<boolean> {
  if (accounts.some((account) => account.provider === harness.provider && account.status === 'ready')) return true;
  return installed && hasAuthEvidence(harness) && await authEvidencePresent(harness, {}).catch(() => false);
}

/** Every provider /provider lists, in its order: the ClikDeploy Gateway, then every harness that runs turns
 * (compareProviders). Models that run on this computer are not a provider of their own: they are hosted AI under the
 * Gateway (hosted-models/), so a chat on one is on the Gateway here. */
export async function providerRows(config: Conf, state: HarnessState, session: HarnessSession | undefined): Promise<IdeProvider[]> {
  const harnesses = allLocalHarnesses().filter((harness) => harnessCanRunTurns(harness));
  const inspected = await Promise.all(harnesses.map(async (harness) => {
    const inspection = await inspectNativeHarnessForPicker(harness);
    return { harness, inspection, signedIn: await harnessSignedIn(harness, state.accounts, inspection.installed) };
  }));
  // PROVIDER_ORDER, then installed, then tier, then catalog order (the sort is stable).
  inspected.sort((left, right) => compareProviders(
    { harness: left.harness, installed: left.inspection.installed }, { harness: right.harness, installed: right.inspection.installed }));
  return [
    {
      id: GATEWAY_ID, kind: 'gateway', name: GATEWAY_LABEL, installed: true, install: 'ready',
      signedIn: Boolean(getApiKeyForUrl(config, getApiUrl(config))), current: isClikCodeAgent(session), choosesModel: true,
    },
    ...inspected.map(({ harness, inspection, signedIn }): IdeProvider => ({
      id: harness.command, kind: 'harness', name: harness.displayName, installed: inspection.installed,
      ...(inspection.version ? { version: inspection.version } : {}),
      install: inspection.installed ? 'ready' : harnessInstallRoute(harness).kind !== 'none' ? 'auto' : 'manual',
      integration: integrationLabel(harness),
      signedIn,
      current: session?.route === 'local' && session.nativeHarness === harness.command,
      choosesModel: harnessSupportsModelSelection(harness),
    })),
  ];
}

/** Whether an account can be added for this harness here: a key it takes,
 * or a sign-in it publishes. */
export function harnessCanAddAccount(harness: AiLocalHarnessDefinition): boolean {
  return harness.localAuth.includes('api-key') || Boolean(harness.loginArgv);
}

/** An account's row, without its usage: the one problem it shows (verify,
 * then reauth, then out of usage), its Tab actions and, last, its Delete
 * action -- Disconnect for a vendor sign-in that can sign out, else Remove. */
export function accountRow(
  account: AiHarnessAccount, harness: AiLocalHarnessDefinition | undefined, session: HarnessSession | undefined, now = Date.now(),
): Omit<IdeAccount, 'usage'> {
  const neverSignedIn = account.status === 'needs_login' && account.neverSignedIn === true;
  const problem: IdeAccount['problem'] = account.verification ? 'verify'
    : neverSignedIn ? 'sign-in'
      : account.status === 'needs_login' ? 'reauth'
        : quotaRefusalHolds(account, now) ? 'out-of-usage' : undefined;
  const backAt = problem === 'out-of-usage' ? accountBackAt(account, now) : undefined;
  const vendorSignIn = account.authKind === 'vendor-cli';
  const actions: IdeAccount['actions'] = [
    ...(harness?.loginArgv && vendorSignIn && account.status !== 'ready' ? ['reauthenticate' as const] : []),
    ...(account.verification ? ['verified' as const] : []),
    // Nothing to sign out of or remove on one never signed in: signing in
    // is all there is to do.
    ...(neverSignedIn && harness?.loginArgv && vendorSignIn ? []
      : [harness && harnessCanLogout(harness) && vendorSignIn && account.status === 'ready' ? 'disconnect' as const : 'remove' as const]),
  ];
  return {
    id: account.id, provider: account.provider, ...(harness ? { harness: harness.command } : {}),
    providerName: harness?.displayName ?? account.provider, label: account.label, status: account.status,
    ...(problem ? { problem } : {}), current: account.id === session?.accountId, actions,
    ...(backAt ? { backAt } : {}),
  };
}

/** Windows as they are sent and shown: name, use and reset only. */
export const usageWindows = (windows: readonly UsageWindow[]): UsageWindow[] =>
  windows.map((window) => ({ name: window.name, usedPct: window.usedPct, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}), ...(window.advisory ? { advisory: true as const } : {}) }));

/** What an account's usage reads without asking the vendor: the windows it
 * last reported while they still hold, else a balance it reported (a label with no window). */
export function accountUsage(account: AiHarnessAccount, state: HarnessState, now = Date.now()): IdeAccount['usage'] {
  const reading = account.usage as AccountUsageReading | undefined;
  const windows = !reading?.failed ? reading?.windows ?? [] : [];
  if (windows.length && usageReadingIsCurrent({ windows }, now)) {
    return accountDisplayUsage(account, { ...(account.usage?.label ? { label: account.usage.label } : {}), windows: usageWindows(windows) }, now);
  }
  const stored = account.usage;
  if (stored?.label && !stored.failed && !windows.length) return { label: stored.label, windows: [] };
  return undefined;
}

/** The effort levels a chat offers, and the one it is set to. The Gateway's
 * fixed scale; a harness's own (effortChoicesFor: what the installed harness
 * says, else the catalog's); none on ClikCode Local or a harness without an
 * effort control. */
export async function effortChoices(
  state: HarnessState, session: HarnessSession, harness: AiLocalHarnessDefinition | undefined = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined,
): Promise<{ current?: string; choices: string[]; gateway?: true } | undefined> {
  if (isGatewayService(session)) {
    const current = gatewayEffort(session);
    return { ...(current ? { current } : {}), choices: [...GATEWAY_EFFORTS], gateway: true };
  }
  if (isClikCodeAgent(session) || !harness || !harnessSupportsEffort(harness)) return undefined;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const choices = (await effortChoicesFor(harness, account, session.model).catch(() => ({ values: [...(harness.effortValues ?? [])] }))).values;
  if (!choices.length) return undefined;
  return { ...(session.effort && session.effort !== 'platform-managed' ? { current: session.effort } : {}), choices };
}

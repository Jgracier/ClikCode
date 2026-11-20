/** The vendor's own session manager, listed for `/sessions`. */

import { PROBE_DEADLINE_MS, isSignedOutRefusal, vendorCommandText } from '../../harness/accounts/vendor-probe.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { localHarnessCapabilityManifest } from '../../runtime/lazy-bridge.js';
import { turnEnvironment } from '../../turn/turn-environment.js';
import { sessionHarness } from './context.js';

export async function nativeManagerListing(state: HarnessState, session: HarnessSession, name: string): Promise<{ label: string; text: string }> {
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider first.');
  const manager = (localHarnessCapabilityManifest(harness).managers as Record<string, { label: string; listArgv?: readonly string[] } | undefined> | undefined)?.[name];
  if (!manager) throw new Error(`${harness.displayName} does not publish a ${name} manager.`);
  if (!manager.listArgv) throw new Error(`${harness.displayName} manages ${manager.label} only in its own interactive UI; open it from the interactive ClikCode session.`);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  // Headless and behind the sign-in gate: a signed-out vendor is told so, never started into its own sign-in.
  const text = await vendorCommandText({ gate: harness, argv: manager.listArgv, environment: turnEnvironment(harness, account), deadlineMs: PROBE_DEADLINE_MS, cwd: session.workspace })
    .catch((error: unknown) => { throw isSignedOutRefusal(error) ? new Error(`${harness.displayName} is not signed in. Sign in with /login first.`) : error; });
  return { label: manager.label, text: text.trim() || 'No entries.' };
}

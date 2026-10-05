/** Choosing which harness runs the session, by hand or automatically. */

import type Conf from 'conf';
import { getApiKeyForUrl, getApiUrl } from '../../gateway/credentials.js';
import { inspectNativeHarnessForPicker } from '../../harness/transport/native/inspect.js';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessPrompter } from '../../harness/prompter.js';
import { localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { allLocalHarnesses, harnessCanRunTurns, harnessTierRank } from '../../runtime/lazy-bridge.js';
import { providerPickerOptions } from '../../session/options.js';
import { aiHarnessSelect } from '../../commands/ai/harness.js';
import { chooseOption } from './choose.js';
import { authEvidencePresent, hasAuthEvidence } from '../../harness/accounts/auth-files.js';
import { selectProviderConversation } from './conversation.js';
import { accountQuotaSpent } from '../../harness/accounts/usage-reading.js';

export async function interactiveEnginePicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  for (;;) {
    const available = await Promise.all(allLocalHarnesses()
      .filter((harness) => harnessCanRunTurns(harness))
      .map(async (harness) => ({ harness, inspection: await inspectNativeHarnessForPicker(harness) })));
    const state = await readState({ transcripts: [id] });
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`AI session "${id}" was not found`);
    const gatewayConnected = Boolean(getApiKeyForUrl(config, getApiUrl(config)));
    const configuredProviders = new Set(state.accounts.map((account) => account.provider));
    const provider = await chooseOption(rl, 'Choose a provider', providerPickerOptions(available, session, gatewayConnected, configuredProviders));
    if (!provider) return undefined;
    if (provider.kind === 'gateway') return selectProviderConversation(config, rl, id, '__gateway__');
    if (provider.kind === 'clikcode-local') return selectProviderConversation(config, rl, id, '__clikcode_local__');
    if (provider.kind !== 'provider') continue;
    return selectProviderConversation(config, rl, id, provider.harness);
  }
}

/**
 * Bind a session to its native agent without asking. A session that already
 * names a provider or account is matched to that agent; a session with no
 * signal picks the first installed harness the user is already signed in to
 * (a ready account, or a credential the vendor keeps on disk), then the first
 * installed one in tier order. Tier alone put a user signed in only to Codex
 * on an installed, signed-out Claude Code and straight into its login.
 * Never signs in or installs: nobody asked for this provider yet. Its first
 * turn signs in if it needs to.
 * Returns false only when nothing useful is installed.
 *
 * Installed means on PATH (inspectNativeHarnessForPicker): the version probe
 * the full inspection adds says nothing about whether the binary is there,
 * and run one harness at a time with a 1.5 s limit each it took ~12 s to
 * open a new chat on a machine with 29 harnesses. Every candidate is asked
 * at once; the choice is still the first in tier order.
 */
export async function autoSelectSessionHarness(id: string): Promise<boolean> {
  const isInstalled = async (harness: AiLocalHarnessDefinition): Promise<boolean> => (await inspectNativeHarnessForPicker(harness)).installed;
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return false;
  if (session.nativeHarness) return true;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const preferred = localHarnessForProvider(session.provider ?? account?.provider ?? '');
  if (preferred && await isInstalled(preferred)) {
    await aiHarnessSelect(preferred.command, id, { emit: false, signIn: false });
    return true;
  }
  const candidates = allLocalHarnesses()
    .filter((harness) => harnessCanRunTurns(harness))
    .sort((left, right) => harnessTierRank(left) - harnessTierRank(right));
  const readyProviders = new Set(state.accounts.filter((item) => item.status === 'ready' && !accountQuotaSpent(item)).map((item) => item.provider));
  const signedIn = async (harness: AiLocalHarnessDefinition): Promise<boolean> =>
    readyProviders.has(harness.provider) || (hasAuthEvidence(harness) && await authEvidencePresent(harness, {}));
  const installed = (await Promise.all(candidates.map(async (harness) => (await isInstalled(harness) ? harness : undefined))))
    .filter((harness): harness is AiLocalHarnessDefinition => harness !== undefined);
  const ready = await Promise.all(installed.map(signedIn));
  const chosen = installed.find((_harness, index) => ready[index]) ?? installed[0];
  if (!chosen) return false;
  await aiHarnessSelect(chosen.command, id, { emit: false, signIn: false });
  return true;
}

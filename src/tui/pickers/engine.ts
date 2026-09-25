/** Choosing which harness runs the session, by hand or automatically. */

import type Conf from 'conf';
import { getApiKeyForUrl, getApiUrl } from '../../gateway/credentials.js';
import { inspectNativeHarness, inspectNativeHarnessForPicker } from '../../harness/transport/native/inspect.js';
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

export async function interactiveEnginePicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  for (;;) {
    const available = await Promise.all(allLocalHarnesses()
      .filter((harness) => harnessCanRunTurns(harness))
      .map(async (harness) => ({ harness, inspection: await inspectNativeHarnessForPicker(harness) })));
    const state = await readState();
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`AI session "${id}" was not found`);
    const gatewayConnected = Boolean(getApiKeyForUrl(config, getApiUrl(config)));
    const configuredProviders = new Set(state.accounts.map((account) => account.provider));
    const provider = await chooseOption(rl, 'Choose a provider', providerPickerOptions(available, session, gatewayConnected, configuredProviders));
    if (!provider) return undefined;
    if (provider.kind === 'gateway') return selectProviderConversation(config, rl, id, '__gateway__');
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
 * Returns false only when nothing useful is installed.
 */
export async function autoSelectSessionHarness(id: string): Promise<boolean> {
  const installedCache = new Map<string, boolean>();
  const isInstalled = async (harness?: AiLocalHarnessDefinition): Promise<boolean> => {
    if (!harness) return false;
    const known = installedCache.get(harness.command);
    if (known !== undefined) return known;
    const inspection = await inspectNativeHarness(harness, 1_500);
    installedCache.set(harness.command, inspection.installed);
    return inspection.installed;
  };
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return false;
  if (session.nativeHarness) return true;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const preferred = localHarnessForProvider(session.provider ?? account?.provider ?? '');
  if (preferred && await isInstalled(preferred)) {
    await aiHarnessSelect(preferred.command, id, { emit: false });
    return true;
  }
  const candidates = allLocalHarnesses()
    .filter((harness) => harnessCanRunTurns(harness))
    .sort((left, right) => harnessTierRank(left) - harnessTierRank(right));
  const readyProviders = new Set(state.accounts.filter((item) => item.status === 'ready' && item.quotaState !== 'exhausted').map((item) => item.provider));
  const signedIn = async (harness: AiLocalHarnessDefinition): Promise<boolean> =>
    readyProviders.has(harness.provider) || (hasAuthEvidence(harness) && await authEvidencePresent(harness, {}));
  let fallback: AiLocalHarnessDefinition | undefined;
  for (const harness of candidates) {
    if (!await isInstalled(harness)) continue;
    fallback ??= harness;
    if (await signedIn(harness)) {
      await aiHarnessSelect(harness.command, id, { emit: false });
      return true;
    }
  }
  if (!fallback) return false;
  await aiHarnessSelect(fallback.command, id, { emit: false });
  return true;
}

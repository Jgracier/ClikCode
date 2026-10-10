/** Choosing which harness runs the session, by hand or automatically. */

import type Conf from 'conf';
import { inspectNativeHarnessForPicker } from '../../harness/transport/native/inspect.js';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import type { IdeProvider } from '../../ide/protocol.js';
import { localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { allLocalHarnesses, harnessCanRunTurns, harnessTierRank } from '../../runtime/lazy-bridge.js';
import { GATEWAY_ID, harnessSignedIn, LOCAL_ID, providerRows } from '../../session/picker-rows.js';
import { aiHarnessSelect } from '../../commands/ai/harness.js';
import { chooseOption } from './choose.js';
import { selectProviderConversation } from './conversation.js';

/** /provider's rows (picker-rows.ts providerRows) as the terminal shows them;
 * the value is the provider's id, as the editor's `choose` takes it. */
export function providerPickerOptions(rows: readonly IdeProvider[]): PickerOption<string>[] {
  return rows.map((row) => {
    // First, so a narrow screen cuts the description, never "current".
    const current = row.current ? '· current ' : '';
    if (row.kind === 'gateway') return { label: row.name, detail: `${current}· ${row.signedIn ? 'connected' : 'sign in with OAuth'}`, value: row.id };
    if (row.kind === 'clikcode-local') return { label: row.name, detail: `${current}· local models on this machine`, value: row.id };
    const install = row.install === 'ready' ? `installed${row.version ? ` ${row.version}` : ''}` : row.install === 'auto' ? 'installs when chosen' : 'install it yourself';
    return { label: row.name, detail: `${current}· ${install} · ${row.integration}`, value: row.id };
  });
}

export async function interactiveEnginePicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const provider = await chooseOption(rl, 'Choose a provider', providerPickerOptions(await providerRows(config, state, session)));
  return provider ? selectProviderConversation(config, rl, id, providerConversationKey(provider)) : undefined;
}

/** The provider id a row (or the editor's `choose`) names, as
 * selectProviderConversation takes it. */
export function providerConversationKey(provider: string): string {
  return provider === GATEWAY_ID ? '__gateway__' : provider === LOCAL_ID ? '__clikcode_local__' : provider;
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
  const installed = (await Promise.all(candidates.map(async (harness) => (await isInstalled(harness) ? harness : undefined))))
    .filter((harness): harness is AiLocalHarnessDefinition => harness !== undefined);
  const ready = await Promise.all(installed.map((harness) => harnessSignedIn(harness, state.accounts, true)));
  const chosen = installed.find((_harness, index) => ready[index]) ?? installed[0];
  if (!chosen) return false;
  await aiHarnessSelect(chosen.command, id, { emit: false, signIn: false });
  return true;
}

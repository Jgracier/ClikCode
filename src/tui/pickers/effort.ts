/** Choosing reasoning effort, for the harnesses that expose it. */

import { isGatewayService } from '../../session/route.js';
import type { HarnessPrompter } from '../../harness/prompter.js';
import { harnessSupportsEffort, localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { optionForHarness, VALID_EFFORTS } from '../../session/options.js';
import { chooseOption } from './choose.js';
import { effortChoicesFor } from '../../harness/accounts/effort-choices.js';
import { applyToChat, settingLabel } from './setting-scope.js';
import { GATEWAY_EFFORTS, gatewayEffort } from '../../gateway/options.js';

export async function interactiveEffortPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (isGatewayService(session)) {
    // The Gateway takes a level with every step; a model that does not reason ignores it.
    const current = gatewayEffort(session);
    const selected = await chooseOption(rl, 'Reasoning effort', [
      { label: 'Default', detail: `· the model decides${current ? '' : ' · current'}`, value: 'default' },
      ...GATEWAY_EFFORTS.map((value) => ({ label: settingLabel(value), detail: value === current ? '· current' : value === 'none' ? '· least reasoning the model allows' : undefined, value })),
    ]);
    if (selected) { await applyToChat(id, 'effort', selected); rl.notice?.(`Effort set to ${settingLabel(selected === 'default' ? '' : selected)}`); }
    return;
  }
  if (session.route === 'clikcode-local') throw new Error('ClikCode Local does not publish a reasoning-effort control yet.');
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (harness && !harnessSupportsEffort(harness)) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag.`);
  // What the installed harness says it accepts -- for Codex, what THIS model
  // accepts -- before the catalog's hand-verified list, and the generic list
  // only when neither says anything. See effort-choices.ts.
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const discovered = harness ? (await effortChoicesFor(harness, account, session.model)).values : [];
  const effortOption = harness ? optionForHarness(harness, 'effort') : undefined;
  const efforts = discovered.length ? discovered : effortOption?.values?.length ? effortOption.values : VALID_EFFORTS;
  const selected = await chooseOption(rl, 'Reasoning effort', [
    { label: 'Default', detail: `· ${harness?.displayName ?? 'the harness'} decides${session.effort ? '' : ' · current'}`, value: 'default' },
    ...efforts.map((value) => ({ label: settingLabel(value), detail: value === session.effort ? '· current' : undefined, value })),
  ]);
  if (selected) { await applyToChat(id, 'effort', selected); rl.notice?.(`Effort set to ${settingLabel(selected === 'default' ? '' : selected)}`); }
}

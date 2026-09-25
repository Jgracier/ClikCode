/** Choosing reasoning effort, for the harnesses that expose it. */

import type { HarnessPrompter } from '../../harness/prompter.js';
import { harnessSupportsEffort, localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { optionForHarness, VALID_EFFORTS } from '../../session/options.js';
import { chooseOption } from './choose.js';
import { effortChoicesFor } from '../../harness/accounts/effort-choices.js';
import { applyToChat, settingLabel } from './setting-scope.js';

export async function interactiveEffortPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway reasoning effort is selected by platform routing policy.');
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
  if (selected) await applyToChat(id, 'effort', selected);
}

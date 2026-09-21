/** Choosing reasoning effort, for the harnesses that expose it. */

import type { HarnessPrompter } from '../../harness/types.js';
import { harnessSupportsEffort, localHarnessForCommand } from '../../harness/transport/native-protocol.js';
import { readState } from '../../session/state/read.js';
import { optionForHarness, VALID_EFFORTS } from '../../session/options.js';
import { chooseOption } from './choose.js';
import { applySettingScope } from './settings.js';

export async function interactiveEffortPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway reasoning effort is selected by platform routing policy.');
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (harness && !harnessSupportsEffort(harness)) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag.`);
  const effortOption = harness ? optionForHarness(harness, 'effort') : undefined;
  const efforts = effortOption?.values?.length ? effortOption.values : VALID_EFFORTS;
  const selected = await chooseOption(rl, 'Choose reasoning effort', efforts.map((value) => ({
    label: value, detail: value === session.effort ? '· current' : undefined, value,
  })));
  if (selected) await applySettingScope(rl, id, 'effort', selected);
}

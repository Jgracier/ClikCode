/** Choosing reasoning effort, for the harnesses that expose it. */

import type { HarnessPrompter } from '../../harness/prompter.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { effortChoices } from '../../session/picker-rows.js';
import { chooseOption } from './choose.js';
import { applyToChat, settingLabel } from './setting-scope.js';

export async function interactiveEffortPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'clikcode-local') throw new Error('ClikCode Local does not publish a reasoning-effort control yet.');
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const effort = await effortChoices(state, session, harness);
  if (!effort) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a configurable reasoning-effort flag.`);
  // The Gateway takes a level with every step; a model that does not reason ignores it.
  const decides = effort.gateway ? 'the model decides' : `${harness?.displayName ?? 'the harness'} decides`;
  const selected = await chooseOption(rl, 'Reasoning effort', [
    { label: 'Default', detail: `${effort.current ? '' : '· current '}· ${decides}`, value: 'default' },
    ...effort.choices.map((value) => ({
      label: settingLabel(value),
      detail: value === effort.current ? '· current' : effort.gateway && value === 'none' ? '· least reasoning the model allows' : undefined,
      value,
    })),
  ]);
  if (selected) { await applyToChat(id, 'effort', selected); rl.notice?.(`Effort set to ${settingLabel(selected === 'default' ? '' : selected)}`); }
}

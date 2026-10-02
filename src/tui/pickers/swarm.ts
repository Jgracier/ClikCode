/** `/swarm` with no argument: Off and On. Accounts stay in Accounts. */

import type { HarnessPrompter } from '../../harness/prompter.js';
import type { HarnessSession } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { swarmIsOn } from '../../swarm/policy.js';
import { aiSessionCommand } from '../slash/handlers.js';
import { chooseOption } from './choose.js';

export function swarmSwitch(session: HarnessSession, id: string): {
  choices: Array<{ label: string; value: string }>;
  current: string;
  apply: (value: string) => Promise<void>;
} {
  return {
    choices: [{ label: 'Off', value: 'off' }, { label: 'On', value: 'on' }],
    current: swarmIsOn(session) ? 'on' : 'off',
    apply: (value) => aiSessionCommand(id, `/swarm ${value}`).then(() => undefined),
  };
}

export async function interactiveSwarmPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const current = swarmIsOn(session) ? 'on' : 'off';
  const selected = await chooseOption(rl, 'Swarm', [
    { label: 'Off', detail: current === 'off' ? 'current' : undefined, value: 'off' },
    { label: 'On', detail: current === 'on' ? 'current' : undefined, value: 'on' },
  ]);
  if (selected && selected !== current) await aiSessionCommand(id, `/swarm ${selected}`);
}

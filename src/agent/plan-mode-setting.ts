/** Plan mode for a chat on ClikCode's own agent (the Gateway, ClikCode Local), as Settings and
 * the editor's footer set it. The agent reads it at each turn's start (gateway/harness.ts) and
 * the turn clears it when the user approves the plan (exit_plan_mode). */
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { isClikCodeAgent } from '../session/route.js';

export async function setAgentPlanMode(id: string, on: boolean): Promise<void> {
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (!isClikCodeAgent(session)) throw new Error('Plan mode here is for ClikCode\'s own agent; a provider keeps its own.');
  if (on === (session.planMode === true)) return;
  if (on) session.planMode = true;
  else delete session.planMode;
  await writeState(state);
}

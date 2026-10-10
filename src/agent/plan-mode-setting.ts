/** Plan mode kept on the chat itself (session.planMode): for ClikCode's own agent (the Gateway,
 * ClikCode Local), and for a vendor whose plan mode is an ACP session mode (catalog
 * `acp.planModeId`: Claude Code's `plan`). Settings and the editor's footer set it; the turn reads
 * it at its start and clears it when the user approves the plan (exit_plan_mode, or the agent
 * leaving its plan mode). A vendor whose plan mode is a CLI option keeps it in harnessOptions. */
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { isClikCodeAgent } from '../session/route.js';
import type { HarnessSession } from '../session/model.js';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';

/** Whether this chat's plan mode is session.planMode. */
export function planModeOnChat(session: Pick<HarnessSession, 'route'>, harness: Pick<AiLocalHarnessDefinition, 'acp'> | undefined): boolean {
  return isClikCodeAgent(session) || Boolean(harness?.acp?.planModeId);
}

export async function setAgentPlanMode(id: string, on: boolean): Promise<void> {
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const harness = !isClikCodeAgent(session) && session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (!planModeOnChat(session, harness)) throw new Error('This provider keeps its plan mode among its own options.');
  if (on === (session.planMode === true)) return;
  if (on) session.planMode = true;
  else delete session.planMode;
  await writeState(state);
}

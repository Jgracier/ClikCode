/** `/compact`: the vendor's own compaction, relayed. */

import type { HarnessSession } from '../../session/model.js';
import { hasConversationContent } from '../../session/options.js';
import { nativeAvailableCommands, persistentTransports } from '../../turn/vendor-process.js';
import { sessionHarness } from './context.js';
import { AGENT_COMPACTS_ITSELF, isClikCodeAgent } from '../../session/route.js';

/** `/compact`. Only a harness that compacts itself does: one that runs slash
 * commands gets `/compact`, and a server with a compact operation (Codex
 * `thread/compact/start`, on the transport's live child) is asked to. Where a
 * vendor has neither, there is no compaction to relay and nothing is sent.
 * ClikCode's own agent (Gateway or ClikCode Local) compacts its context
 * locally as it nears the window. */
export async function compactConversation(
  id: string, session: HarnessSession, focus: string, send: (id: string, prompt: string) => Promise<void>,
): Promise<void> {
  if (isClikCodeAgent(session)) throw new Error(AGENT_COMPACTS_ITSELF);
  if (!hasConversationContent(session)) throw new Error('There is nothing to compact yet.');
  const harness = sessionHarness(session);
  const command = compactCommand(id, session);
  if (command) {
    await send(id, `${command}${focus ? ` ${focus}` : ''}`);
    return;
  }
  if (harness?.nativeOperations?.includes('compact') && session.nativeSessionId) {
    const live = persistentTransports.get(id);
    const compactor = live?.transport === 'codex-app-server' ? (live.session as unknown as { compactThread?: (threadId: string) => Promise<boolean> }) : undefined;
    if (compactor?.compactThread && await compactor.compactThread(session.nativeSessionId)) return;
  }
  throw new Error(`/compact is not available for ${harness?.displayName ?? 'this provider'}.`);
}

/** The slash command that compacts this conversation in its harness, if it has one: `/compact` for a
 * harness that takes its own slash commands, else whatever compaction command the agent itself
 * advertised this session (ACP `available_commands_update`: `compact`, or Gemini's `compress`). */
export function compactCommand(id: string, session: HarnessSession): string | undefined {
  if (!session.nativeSessionId) return undefined;
  if (sessionHarness(session)?.nativeSlashPassthrough) return '/compact';
  const advertised = (nativeAvailableCommands.get(id) ?? []).find((command) => command.name === 'compact' || command.name === 'compress');
  return advertised ? `/${advertised.name}` : undefined;
}

/** Whether this conversation's harness can compact it (compactConversation would not refuse). */
export function canCompact(id: string, session: HarnessSession): boolean {
  if (isClikCodeAgent(session) || !session.nativeSessionId) return false;
  return Boolean(compactCommand(id, session)) || Boolean(sessionHarness(session)?.nativeOperations?.includes('compact'));
}

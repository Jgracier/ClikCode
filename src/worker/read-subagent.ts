/** Subagent history belongs to the conversation worker, shared by every UI. */
import { quiet } from '../runtime/lifecycle-log.js';
import type { HarnessSession } from '../session/model.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import { readTurnActivities } from '../turn/turn-activities.js';
import { liveSubAgentRows, readClaudeSubagent, type SubAgentRow } from '../harness/subagent-read.js';
import { persistentTransports } from '../turn/vendor-process.js';
import type { CodexSession } from '../harness/transport/codex-app-server.js';
import { nativeProfileEnvironment } from '../harness/transport/profile-environment.js';
import { readCodexFsTranscript } from '../session/discovery/vendors/codex.js';
import { isClikCodeAgent } from '../session/route.js';

export function conversationSubagentEvents(session: HarnessSession) {
  return [
    ...(session.messages ?? []).flatMap((message) => readTurnActivities(message.activities, message.content.length)),
    ...readTurnActivities(session.pendingTurn?.activities, session.pendingTurn?.response?.length ?? 0),
  ].map((activity) => activity.event);
}

export async function readConversationSubagent(session: HarnessSession, account: AiHarnessAccount | undefined, parentId: string): Promise<SubAgentRow[]> {
  const events = conversationSubagentEvents(session);
  const agent = [...events].reverse().find((event) => event.id === parentId && event.agent && event.agentId)
    ?? events.find((event) => event.id === parentId && event.agent);
  if (!agent) return [];
  const frames = liveSubAgentRows(events, parentId);
  if (isClikCodeAgent(session)) return frames;
  if (session.nativeHarness === 'codex') {
    const threadId = agent.agentId ?? /^agent:(.+)$/.exec(parentId)?.[1];
    const held = persistentTransports.get(session.id);
    if (held?.transport === 'codex-app-server') {
      if (threadId) {
        const rows = await (held.session as CodexSession).readSubagentThread(threadId).catch(() => []);
        if (rows.length) return rows;
      }
    }
    if (threadId) {
      const messages = await readCodexFsTranscript(threadId, session.workspace ?? '', nativeProfileEnvironment(account?.nativeProfile)).catch(() => []);
      if (messages.length) return [
        ...messages.map((message): SubAgentRow => ({ kind: message.role === 'user' ? 'prompt' : 'text', text: message.content })),
        ...(frames.length ? [{ kind: 'text', text: 'Recorded tool activity:' } as const, ...frames] : []),
      ];
    }
  } else if (session.nativeHarness === 'claude' && session.nativeSessionId) {
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    const found = await readClaudeSubagent(session.workspace ?? '', session.nativeSessionId, parentId, environment.CLAUDE_CONFIG_DIR).catch(quiet('worker/read-subagent'));
    if (found?.rows.length) return found.rows;
  }
  return frames;
}

/** `/compact`: replacing a long conversation with a summary of itself. */

import type { HarnessSession } from '../../harness/types.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { closePersistentTransport } from '../../turn/runtime.js';
import { conversationIdFor, hasConversationContent } from '../../session/options.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { newConversationSession } from '../../commands/ai.js';
import { sessionHarness } from './context.js';

const COMPACT_PROMPT = 'Summarize this conversation so far for a fresh session that will continue the work. Include: the goal, decisions made and why, files created or changed (with paths), commands that matter, the current state, and the concrete next steps. Be complete but concise. Output only the summary.';

/** `/compact`. A harness that runs slash commands itself compacts natively.
 * Otherwise ClikCode does it: one turn produces the summary, then a fresh
 * branch of the same conversation is seeded with only that summary -- with no
 * native session id, so its first turn replays the summary into a brand-new
 * vendor session. The full transcript stays on the original, resumable. */
export async function compactConversation(
  id: string, session: HarnessSession, focus: string, send: (id: string, prompt: string) => Promise<void>,
): Promise<string | void> {
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway manages its own context; /compact applies only to local harnesses.');
  if (!hasConversationContent(session)) throw new Error('There is nothing to compact yet.');
  const harness = sessionHarness(session);
  if (harness?.nativeSlashPassthrough && session.nativeSessionId) {
    await send(id, `/compact${focus ? ` ${focus}` : ''}`);
    return;
  }
  await send(id, `${COMPACT_PROMPT}${focus ? `\nPay particular attention to: ${focus}` : ''}`);
  const state = await readState();
  const source = state.sessions.find((item) => item.id === id);
  if (!source) throw new Error(`AI session "${id}" was not found`);
  const summary = [...sessionTranscriptMessages(source)].reverse().find((message) => message.role === 'assistant')?.content.trim();
  if (!summary) throw new Error('The provider returned no summary; the conversation was left as it was.');
  const compacted: HarnessSession = {
    ...newConversationSession(state, source),
    conversationId: conversationIdFor(source), parentSessionId: source.id,
    ...(source.name ? { name: source.name } : {}),
    ...(source.harnessOptions ? { harnessOptions: { ...source.harnessOptions } } : {}),
    messages: [
      { role: 'user', content: 'Summary of the conversation so far (compacted by ClikCode):' },
      { role: 'assistant', content: summary },
    ],
  };
  state.sessions.push(compacted);
  await writeState(state);
  await closePersistentTransport(id);
  return compacted.id;
}

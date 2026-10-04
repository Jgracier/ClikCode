/** Rehydrate an interrupted request from its durable checkpoint. */
import { sessionTranscriptMessages, type PendingTurnWithHints } from './checkpoint.js';
import type { HarnessSession } from '../session/model.js';
import { textTranscript } from './turn-activities.js';
import { failoverPrompt, INTERRUPTED_TURN_REQUEST, type FailoverPromptOptions } from './failover-prompt.js';

/** Rehydration prompt for a turn that was cut off mid-flight, including the
 * files it is known to have started changing. `requestContext` is what the
 * request carried besides its typed words (attached files): the journal keeps
 * only the words, and a fresh thread gets nothing but this retelling. */
export function interruptedTurnFailoverPrompt(
  session: HarnessSession, options: FailoverPromptOptions & { requestContext?: string } = {},
): string {
  const { requestContext, ...promptOptions } = options;
  const pending = session.pendingTurn;
  const touchedFiles = promptOptions.touchedFiles ?? (pending as PendingTurnWithHints | undefined)?.touchedFiles;
  const retold = pending && requestContext ? { ...session, pendingTurn: { ...pending, prompt: `${pending.prompt}${requestContext}` } } : session;
  return failoverPrompt(textTranscript(sessionTranscriptMessages(retold)), INTERRUPTED_TURN_REQUEST, { ...promptOptions, ...(touchedFiles ? { touchedFiles } : {}) });
}

/** Rehydrate an interrupted request from its durable checkpoint. */
import { sessionTranscriptMessages, type PendingTurnWithHints } from './checkpoint.js';
import type { HarnessSession } from '../session/model.js';
import { failoverPrompt, INTERRUPTED_TURN_REQUEST, type FailoverPromptOptions } from './failover-prompt.js';

/** Rehydration prompt for a turn that was cut off mid-flight, including the
 * files it is known to have started changing. */
export function interruptedTurnFailoverPrompt(session: HarnessSession, options: FailoverPromptOptions = {}): string {
  const touchedFiles = options.touchedFiles ?? (session.pendingTurn as PendingTurnWithHints | undefined)?.touchedFiles;
  return failoverPrompt(sessionTranscriptMessages(session), INTERRUPTED_TURN_REQUEST, { ...options, ...(touchedFiles ? { touchedFiles } : {}) });
}

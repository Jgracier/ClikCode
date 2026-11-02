/** Explicit expansion reads the owner's stored detail, never the wire preview. */
import type { HarnessSession } from '../session/model.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';

export function activityDetails(session: HarnessSession, ids: readonly string[], scope: { messageIndex?: number; userIndex?: number } = {}): HarnessActivityEvent[] {
  const wanted = new Set(ids);
  const found = new Map<string, HarnessActivityEvent>();
  const visit = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const event = item?.event as HarnessActivityEvent | undefined;
      if (event?.id && wanted.has(event.id)) found.set(event.id, event);
    }
  };
  const messages = session.messages ?? [];
  if (scope.messageIndex !== undefined && scope.messageIndex < messages.length) {
    visit(messages[scope.messageIndex]?.activities);
  } else if (scope.userIndex !== undefined) {
    const answer = messages.slice(scope.userIndex + 1).find((message) => message.role === 'assistant');
    if (answer) visit(answer.activities); else visit(session.pendingTurn?.activities);
  } else visit(session.pendingTurn?.activities);
  return [...found.values()];
}

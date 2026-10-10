/** The line a turn ends on ("Worked for 12s · 2 files changed", "Stopped
 * after 3s"), drawn from the saved conversation: the answer a turn ended on
 * carries how long it took (TranscriptMessage.turnEnd), and its calls are
 * those of every answer since the user's message that started it. Saved,
 * it is there however the conversation is opened again. */
import type { HarnessSession } from '../../session/model.js';
import { readTurnActivities } from '../../turn/turn-activities.js';
import { endsWithSummary, turnSummary } from '../../harness/protocol/turn-flow.js';

type Message = NonNullable<HarnessSession['messages']>[number];

export function turnEndLine(messages: readonly Message[], index: number): string | undefined {
  const end = messages[index]?.turnEnd;
  if (!end) return undefined;
  const events = [];
  // Back to the message that started the turn: a steer (a user message with
  // an id) was typed into it, and is part of it.
  for (let at = index; at >= 0; at -= 1) {
    const message = messages[at]!;
    if (message.role === 'user' && !message.id) break;
    if (message.role !== 'assistant') continue;
    for (const activity of readTurnActivities(message.activities, message.content.length)) {
      if (activity.event.kind !== 'thinking') events.push(activity.event);
    }
  }
  const stopped = Boolean(end.stopped) || events.some((event) => event.stopped);
  if (!stopped && !endsWithSummary(end.ms, events.length)) return undefined;
  return turnSummary({ ms: end.ms, stopped, diffs: events.flatMap((event) => (event.diff?.length ? [event.diff] : [])) });
}

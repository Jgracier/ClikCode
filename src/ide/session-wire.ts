/** What a viewer on another machine is sent of a long chat's older messages.
 *
 * Opening a chat there used to send all of it: one 33 MB chat was 25 MB over
 * SSH, 24 seconds before the first line showed -- 23 MB of it the tool calls'
 * output and input of messages nobody was looking at. The newest messages go
 * whole; the ones before keep what their rows show (a few lines of output, a
 * few of the diff), and the oldest the rows alone. The text is always whole,
 * and so is the count of calls, which is what the message's fingerprint reads
 * (session-delta.ts). The machine that owns the chat keeps everything. */
import type { HarnessSession } from '../session/model.js';
import { viewedActivity } from '../turn/turn-activities.js';

type Message = NonNullable<HarnessSession['messages']>[number];

/** Messages from the end sent with their calls whole: the screenful being read. */
export const WHOLE_MESSAGES = 8;
/** Messages from the end sent with each call's preview; the ones before, the rows alone. */
export const PREVIEW_MESSAGES = 48;

export function wireMessage(message: Message, after: number): Message {
  if (after < WHOLE_MESSAGES || !message.activities?.length) return message;
  const bare = after >= PREVIEW_MESSAGES;
  // Only records are cut; anything else a saved chat holds there stays as it is.
  const activities = message.activities.map((item) => (item && typeof item === 'object' && 'event' in item ? viewedActivity(item, bare) : item));
  return { ...message, activities };
}

/** Calls of the running turn sent whole: what is on screen being worked on. The turn's earlier calls are previews, then rows alone. */
export const WHOLE_CALLS = 12;
/** Calls from the newest sent as previews; the ones before, the rows alone. */
export const PREVIEW_CALLS = 40;

/** The running turn's calls as a viewer is sent them, newest whole -- the same number of calls, in the same order. */
export function wireCalls<A>(activities: A[]): A[] {
  return activities.map((item, index) => {
    const after = activities.length - 1 - index;
    if (after < WHOLE_CALLS || !item || typeof item !== 'object' || !('event' in item)) return item;
    return viewedActivity(item as never, after >= PREVIEW_CALLS) as A;
  });
}

/** The journal of the running turn, its calls as `wireCalls`. */
export function wireTurn(turn: NonNullable<HarnessSession['pendingTurn']>): NonNullable<HarnessSession['pendingTurn']> {
  return turn.activities?.length ? { ...turn, activities: wireCalls(turn.activities) } : turn;
}

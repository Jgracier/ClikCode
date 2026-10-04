/** `/fork @N`: a fork that keeps the conversation through user message N
 * and its answer. Numbered from 1, the oldest; ClikCode's own continuation
 * prompts are not the user's and are not counted. */
import type { TranscriptMessage } from '../../session/model.js';
import type { PickerOption } from '../../harness/prompter.js';
import { INTERRUPTED_TURN_REQUEST } from '../../turn/failover-prompt.js';

/** Where each user message sits in `messages`, in order. */
export function userMessageIndexes(messages: readonly TranscriptMessage[]): number[] {
  return messages.flatMap((message, index) => (message.role === 'user' && message.content !== INTERRUPTED_TURN_REQUEST ? [index] : []));
}

/** `@3` -> 3; anything else undefined. */
export function forkPoint(word: string | undefined): number | undefined {
  const match = /^@(\d+)$/.exec(word ?? '');
  return match ? Number(match[1]) : undefined;
}

/** The messages a fork at user message `n` keeps: everything before the next
 * user message. Throws when there is no message `n`. */
export function messagesThrough(messages: readonly TranscriptMessage[], n: number): TranscriptMessage[] {
  const users = userMessageIndexes(messages);
  if (!Number.isInteger(n) || n < 1 || n > users.length) {
    throw new Error(users.length ? `No message ${n}: this conversation has messages 1 to ${users.length}.` : 'This conversation has no messages to fork at yet.');
  }
  return messages.slice(0, users[n] ?? messages.length);
}

/** The picker rows for `/fork` with no N: the user's messages, newest first,
 * each forking after its answer. */
export function forkPointOptions(messages: readonly TranscriptMessage[]): PickerOption<number>[] {
  return userMessageIndexes(messages).map((at, position) => {
    const line = messages[at]!.content.replace(/\s+/g, ' ').trim();
    return { label: `${position + 1}  ${line.length > 72 ? `${line.slice(0, 71)}…` : line}`, value: position + 1 };
  }).reverse();
}

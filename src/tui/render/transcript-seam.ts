/** Where an append-only transcript carries on from what is already on screen.
 *
 * Three decisions, each of which has been wrong in production and each of
 * which is stated here once instead of inline in paint():
 *
 *  - firstUnwritten: which message to resume writing at;
 *  - materializedPendingTurn: whether the pending turn has already been
 *    folded into the persisted list;
 *  - liveAssistantAt: where the answer that just streamed actually landed.
 *
 * The transcript is the terminal's own scrollback, so every one of these is
 * irreversible: a row written twice cannot be unwritten, and a row skipped is
 * gone. That is why they are pure functions with the failures written down as
 * tests, rather than conditions buried in a 480-line paint.
 */

export type TranscriptMessage = { role: string; content: string };

export function messageKey(message: TranscriptMessage): string {
  return `${message.role}:${message.content}`;
}

/** The index to resume writing at.
 *
 * A count alone cannot answer this. The interactive loop hands the turn its
 * own view of the conversation as `messages.slice(-40)`, so the array arriving
 * mid-turn is a WINDOW, not the whole transcript. Counting absolutely, a long
 * conversation had already emitted more messages than the window contains, so
 * the loop started past its end and wrote nothing -- including the message the
 * user had just submitted, which vanished as the answer to it streamed in
 * underneath.
 *
 * The last message actually written identifies the seam wherever it sits,
 * window or not. Searched from the END so that a repeated sentence does not
 * rewind the transcript to its first occurrence. */
export function firstUnwritten(
  persisted: readonly TranscriptMessage[], emittedMessages: number, lastEmittedMessage?: string,
): number {
  let seam = Math.min(emittedMessages, persisted.length);
  if (lastEmittedMessage === undefined) return seam;
  for (let index = persisted.length - 1; index >= 0; index -= 1) {
    if (messageKey(persisted[index]!) === lastEmittedMessage) return index + 1;
  }
  return seam;
}

/** Whether the pending turn has already been folded into the persisted list.
 *
 * More messages were retired than this turn's own list holds, and none of them
 * is the seam. Its steers are therefore in scrollback as real user messages,
 * and scrollback cannot be unwritten -- so the LIVE copies are the ones to
 * drop. */
export function materializedPendingTurn(
  seam: number, persistedLength: number, emittedMessages: number,
): boolean {
  return seam >= persistedLength && emittedMessages > persistedLength;
}

/** Where the answer that just streamed actually landed.
 *
 * While the answer streams, its index is recorded as the length of the list at
 * that moment. By the time the turn is persisted the user's own message may
 * have been materialized into that same list -- it is not always echoed into
 * the pre-turn render -- which shifts the assistant down by one. The recorded
 * index then points at the USER message, the role check fails, and the answer
 * is emitted a second time underneath the copy already on screen: the
 * transcript jumps a screen and the same response is sitting there again.
 *
 * A turn ends with its assistant message, so the first assistant at or after
 * the recorded index is the one that was streamed. */
export function liveAssistantAt(
  persisted: readonly TranscriptMessage[], recorded?: number,
): number | undefined {
  let index = recorded;
  while (index !== undefined && index < persisted.length && persisted[index]!.role !== 'assistant') index += 1;
  return index;
}

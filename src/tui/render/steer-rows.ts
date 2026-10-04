/** Which steers belong in the transcript, when each one has two possible
 *  sources.
 *
 * A steer is a message the user typed while an answer was still streaming.
 * It reaches this decision twice: once live, from the submissions the
 * composer is tracking, and once durably, because sessionTranscriptMessages()
 * materializes it as a real user message. Only one of the two may be drawn.
 *
 * Extracted as a decision rather than left inline because it is the same
 * class of bug as the duplicated response (see response-duplication's tests):
 * a row drawn from two sources reads as the user having said it twice, and
 * nothing about the transcript afterwards can undo that -- it is append-only.
 * The three conditions below are subtle enough to be worth stating once, in
 * one place, with the cases written down.
 */

import { keyHint } from '../../harness/protocol/wording.js';

/** What a message typed during a turn is called on screen, by where it is.
 *  Enter delivers it without stopping anything; Ctrl+S stops the turn --
 *  its tool calls and sub-agents with it -- and sends, which its hint says. */
export const STEER_WORDS = {
  /** Held by the turn until no tool call is open (acp-client.ts). */
  held: 'sending at the next pause',
  steered: 'sent into the turn',
  stopAndSend: keyHint('sendNow'),
} as const;

/** Anything the live composer is tracking. Only 'steered' entries are ever
 *  drawn here; the rest are still in flight or failed. */
export type LiveSubmission = {
  text: string; sequence: number; responseOffset: number; id?: string;
  state: 'sending' | 'queued' | 'steered' | 'error' | 'command';
};

/** A steer already folded into the conversation by the transcript reader. */
export type DurableSteer = { text: string; responseOffset?: number; id?: string };

export type SteerRow = { id: string; done: true; responseOffset: number; lines: string[] };

/** A timed-out steer can be shown as queued before the provider accepts it.
 * Its durable steer then replaces that provisional row under the same id. */
export function hasDurableSteer(
  submission: Pick<LiveSubmission, 'id' | 'text'>, steers: readonly DurableSteer[],
): boolean {
  return steers.some((steer) => submission.id && steer.id
    ? submission.id === steer.id : submission.text === steer.text);
}

export function steerTranscriptRows(input: {
  /** Steers the transcript reader produced, or empty once the pending turn
   *  has been materialized -- at which point they arrive as real messages
   *  instead and drawing them here too would double them. */
  durable: readonly DurableSteer[];
  live: readonly LiveSubmission[];
  materializedPendingTurn: boolean;
  /** Steers already retired this session, by TEXT: once the pending turn is
   *  materialized the live copy has no identity left to match on, so the text
   *  is all there is. Two steers that say the same thing are still two
   *  steers, which is why this only applies after materialization. */
  retiredThisSession: ReadonlySet<string>;
  render: (text: string) => string[];
}): SteerRow[] {
  const durable = input.materializedPendingTurn ? [] : input.durable;
  const rows: SteerRow[] = durable.map((item, index) => ({
    id: `steer#${item.responseOffset ?? 0}#${index}`, done: true,
    responseOffset: item.responseOffset ?? 0, lines: input.render(item.text),
  }));
  for (const item of input.live) {
    if (item.state !== 'steered') continue;
    // Already drawn from the durable side -- by identity where both carry
    // one, so two steers that say the same thing are still two steers.
    if (hasDurableSteer(item, durable)) continue;
    if (input.materializedPendingTurn && input.retiredThisSession.has(item.text)) continue;
    rows.push({ id: `steer#${item.sequence}`, done: true, responseOffset: item.responseOffset, lines: input.render(item.text) });
  }
  return rows;
}

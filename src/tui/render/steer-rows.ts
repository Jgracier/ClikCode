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

/** Anything the live composer is tracking. Only 'steered' entries are ever
 *  drawn here; the rest are still in flight or failed. */
export type LiveSubmission = {
  text: string; sequence: number; responseOffset: number;
  state: 'sending' | 'queued' | 'steered' | 'error';
};

/** A steer already folded into the conversation by the transcript reader. */
export type DurableSteer = { text: string; responseOffset?: number };

export type SteerRow = { id: string; done: true; responseOffset: number; lines: string[] };

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
  const durableTexts = new Set(durable.map((item) => item.text));
  for (const item of input.live) {
    if (item.state !== 'steered') continue;
    // Already drawn from the durable side.
    if (durableTexts.has(item.text)) continue;
    if (input.materializedPendingTurn && input.retiredThisSession.has(item.text)) continue;
    rows.push({ id: `steer#${item.sequence}`, done: true, responseOffset: item.responseOffset, lines: input.render(item.text) });
  }
  return rows;
}

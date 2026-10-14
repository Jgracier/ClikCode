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
 *  Enter delivers it. Enter again, with nothing typed, puts a waiting
 *  message into the chat at the next pause. The turn and its sub-agents
 *  keep running, which its hint says. */
export const STEER_WORDS = {
  /** Held by the turn until no tool call is open (acp-client.ts). */
  held: 'sending at the next pause',
  steered: 'sent into the turn',
  /** `/send steer`, but nothing running could take a steer: it queued. */
  unsteered: "this turn can't take it",
  sendNow: keyHint('sendNow'),
} as const;

/** A message of the user's waiting while a turn runs, as Enter again sees
 *  it: `held` -- the turn is holding it for its next pause already;
 *  `unsteered` -- the turn said it could not take one. */
export type WaitingMessage = { held?: boolean; unsteered?: boolean };

/** Whether Enter again -- nothing typed -- puts the oldest waiting message
 *  (`waiting[0]`, the one the worker takes) into the chat. Not when the turn
 *  already holds it for its next pause: the worker only answers "queued".
 *  Not when this turn could not take a message: sending it again only queues
 *  it again. The hint, the key and VS Code's button all ask this, so none of
 *  them offers what will not happen. */
export function enterAgainSends(waiting: readonly WaitingMessage[]): boolean {
  const oldest = waiting[0];
  return Boolean(oldest) && !oldest!.held && !waiting.some((message) => message.unsteered);
}

/** Anything the live composer is tracking. Only 'steered' entries are ever
 *  drawn here; the rest are still in flight or failed. */
export type LiveSubmission = {
  text: string; sequence: number; responseOffset: number; id?: string;
  /** When the turn acknowledged it: the position it is drawn at. */
  ack?: { sequence: number; responseOffset: number };
  state: 'sending' | 'queued' | 'steered' | 'error' | 'command';
};

/** A steer already folded into the conversation by the transcript reader. */
export type DurableSteer = { text: string; responseOffset?: number; id?: string };

/** A steer's row. `steer` marks it for TurnTranscript (not a call: it does not
 *  close the prose before it). `text` and `steerId` are what the saved
 *  user message that replaces it is matched by (liveTurnSpan). `seq` is the
 *  order it was acknowledged in, among the rows that began around it. */
export type SteerRow = {
  id: string; done: true; responseOffset: number; lines: string[]; steer: true; text: string; steerId?: string; seq?: number;
};

/** A timed-out steer can be shown as queued before the provider accepts it.
 * Its durable steer then replaces that provisional row under the same id. */
export function hasDurableSteer(
  submission: Pick<LiveSubmission, 'id' | 'text'>, steers: readonly DurableSteer[],
): boolean {
  // By identity where both carry one. Text only while one side has none yet:
  // the submission before the worker answered, or a steer stored without one.
  return steers.some((steer) => (submission.id && steer.id
    ? submission.id === steer.id : submission.text === steer.text));
}

/** One id for a steer, whichever copy is drawn: its message id when it has
 *  one (the live copy and the durable copy carry the same), so the row keeps
 *  its identity when the acknowledgement arrives after the snapshot. */
const steerRowId = (id: string | undefined, fallback: string): string => (id ? `steer#${id}` : fallback);

export function steerTranscriptRows(input: {
  /** Steers the transcript reader produced, or empty once the pending turn
   *  has been materialized -- at which point they arrive as real messages
   *  instead and drawing them here too would double them. */
  durable: readonly DurableSteer[];
  live: readonly LiveSubmission[];
  materializedPendingTurn: boolean;
  /** Steers already retired this session. A steer with an id is matched by
   *  that id. Text is only for one that was stored without an id. */
  retiredThisSession: ReadonlySet<string>;
  render: (text: string) => string[];
}): SteerRow[] {
  const durable = input.materializedPendingTurn ? [] : input.durable;
  const steered = input.live.filter((item) => item.state === 'steered');
  const claimed = new Set<number>();
  const rows: SteerRow[] = durable.map((item, index) => {
    // The live copy may already have been retired under its own id, and a
    // row is retired once, by id. The durable copy -- which wins, and carries
    // the offset the worker acknowledged it at -- takes that id, so it is the
    // same row whichever of the two arrived first.
    const live = steered.find((candidate) => !claimed.has(candidate.sequence) && hasDurableSteer(candidate, [item]));
    if (live) claimed.add(live.sequence);
    return {
      id: steerRowId(item.id ?? live?.id, live ? `steer#${live.sequence}` : `steer#${item.responseOffset ?? 0}#${index}`), done: true,
      responseOffset: item.responseOffset ?? 0, lines: input.render(item.text), steer: true, text: item.text,
      ...(item.id ? { steerId: item.id } : {}),
    };
  });
  for (const item of steered) {
    // Already drawn from the durable side -- by identity where both carry
    // one, so two steers that say the same thing are still two steers.
    if (claimed.has(item.sequence) || hasDurableSteer(item, durable)) continue;
    if (input.materializedPendingTurn && input.retiredThisSession.has(item.id ?? item.text)) continue;
    // Placed where it was acknowledged, in the same order every other row
    // is: one that began before sorts above it, one after sorts below.
    rows.push({
      id: steerRowId(item.id, `steer#${item.sequence}`), done: true, responseOffset: item.ack?.responseOffset ?? item.responseOffset,
      lines: input.render(item.text), ...(item.ack ? { seq: item.ack.sequence } : {}),
      steer: true, text: item.text, ...(item.id ? { steerId: item.id } : {}),
    });
  }
  return rows;
}

/** How far a turn drawn live reaches into the saved list.
 *
 * A steer splits the saved answer: [assistant, steer, assistant, ...]. The
 * live turn drew all of it -- one answer with the steers placed in it -- so
 * the saved messages after the first assistant are copies of what is already
 * on screen, and writing them again put every steer and everything after it
 * on screen twice. They are recognised by identity: the steers this window
 * drew (`drawn`, by id where both carry one, else by text), and the answer
 * that follows each. Returns the index of the last message the live turn
 * owns (`start` when it owns no more than the one). A steer this window
 * never drew ends the span there: it is written as the message it is. */
export function liveTurnSpan(
  messages: readonly { role: string; content: string; id?: string }[], start: number,
  drawn: readonly { text: string; steerId?: string }[],
): number {
  const remaining = [...drawn];
  let end = start;
  for (let index = start + 1; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'assistant' && messages[index - 1]!.role === 'user') { end = index; continue; }
    if (message.role !== 'user') break;
    const at = remaining.findIndex((steer) => (steer.steerId && message.id ? steer.steerId === message.id : steer.text.trim() === message.content.trim()));
    if (at < 0) break;
    remaining.splice(at, 1);
    end = index;
  }
  return end;
}

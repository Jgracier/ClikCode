/** A queued message has two sources (live and stored) and they overlap; these are the rows that settle the two into one list. */
import chalk from 'chalk';
import { hasDurableSteer } from '../../render/steer-rows.js';
import type { TerminalHarnessPrompter } from '../../prompter.js';
import type { HarnessSession } from '../../../session/model.js';


export type QueuedMessage = { role: 'user'; content: string; queueState: string; unsteered?: boolean; user: boolean };

/** The queued and waiting messages to draw. */
export function queuedMessagesOf(p: TerminalHarnessPrompter, session: HarnessSession, pending: HarnessSession['pendingTurn']): { queuedMessages: QueuedMessage[] } {
  const storedQueued = session.queuedTurns ?? [];
  // A queued message has two sources and they overlap. It is drawn live the
  // moment it is typed (waitingSubmissions), and the loop then writes it
  // into the session (queuedTurns) -- so between the write landing and the
  // turn consuming it, both hold the same message and it was drawn twice.
  // The stored copy wins, being the one that survives this process. Steers
  // are deduplicated against their durable copy the same way, just below.
  const storedQueuedTexts = new Set(storedQueued.map((item) => item.text));
  const storedQueuedIds = new Set(storedQueued.map((item) => item.id));
  // By identity once the worker has answered with one; by text only in the
  // moment before -- when a match can only be this same message, already
  // written. Matching by text alone showed "yes" sent twice as one row.
  const storedCopy = (item: { id?: string; text: string }): boolean => (item.id ? storedQueuedIds.has(item.id) : storedQueuedTexts.has(item.text));
  // Steering was asked for and nothing running could take it: the row
  // says so, by identity, on whichever copy is drawn.
  const unsteeredIds = new Set(p.waitingSubmissions.flatMap((item) => (item.unsteered && item.id ? [item.id] : [])));
  const queuedMessages: Array<{ role: 'user'; content: string; queueState: string; unsteered?: boolean; user: boolean }> = [
    // A queued COMMAND is not a message and gets no row: it runs when the
    // turn ends and shows whatever it shows then. Nor does a notice
    // ClikCode owes the model: it is not the user's to see.
    ...storedQueued.filter((item) => item.kind !== 'command' && item.kind !== 'notification')
      // Held by the running turn to steer in once no tool call is open
      // (acp-client.ts): it is on its way into this turn, not the next.
      .map((item) => ({
        role: 'user' as const, content: item.text, user: true, ...(unsteeredIds.has(item.id) ? { unsteered: true } : {}),
        queueState: p.turn && item.heldForTurn && item.heldForTurn === pending?.startedAt ? 'pause' as const : 'queued' as const,
      })),
    ...p.waitingSubmissions.filter((item) => item.state !== 'steered' && !storedCopy(item)
      && !hasDurableSteer(item, pending?.steers ?? []))
      .map((item) => ({ role: 'user' as const, content: item.text, queueState: item.state, user: true, ...(item.unsteered ? { unsteered: true } : {}) })),
  ];
  return { queuedMessages };
}

/** The queued messages as rows under the live answer: the message itself
 * (already what the user wrote) and one state word. The keys that act on a
 * waiting message -- Enter again sends it now, Esc takes it back -- are in
 * /help, not repeated on every row. */
export function queuedMessageRows(
  queuedMessages: readonly QueuedMessage[], userRows: (content: string) => readonly string[],
): string[] {
  const liveConversation: string[] = [];
  for (const [queueIndex, message] of queuedMessages.entries()) {
    // Provisional, and so never retired: a queued turn becomes a real user
    // message the moment it is sent, and would then be written a second time.
    const status = message.queueState === 'sending' ? 'sending'
      : message.queueState === 'error' ? 'not sent' : 'queued';
    // The speaker changes once, where the queue begins: two rows there, the
    // same break a settled prompt gets. Between queued messages it is one.
    liveConversation.push(...(queueIndex === 0 ? ['', ''] : ['']), ...userRows(message.content), `  ${chalk.dim(`↳ ${status}`)}`);
  }
  return liveConversation;
}

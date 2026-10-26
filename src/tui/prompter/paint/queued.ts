/** A queued message has two sources (live and stored) and they overlap; these are the rows that settle the two into one list. */
import chalk from 'chalk';
import { terminalCellWidth } from '../../render/width.js';
import { fitHint } from '../../render/footer-rows.js';
import { enterAgainSends, hasDurableSteer, STEER_WORDS } from '../../render/steer-rows.js';
import { keyHint } from '../../../harness/protocol/wording.js';
import type { TerminalHarnessPrompter } from '../../prompter.js';
import type { HarnessSession } from '../../../session/model.js';


type QueuedMessage = { role: 'user'; content: string; queueState: string; unsteered?: boolean; user: boolean };

/** The queued and waiting messages to draw. */
export function queuedMessagesOf(
  p: TerminalHarnessPrompter, session: HarnessSession, pending: HarnessSession['pendingTurn'], drawn: { steers: readonly { text: string; steerId?: string }[]; prompt?: string; materialized?: boolean } = { steers: [] },
): { queuedMessages: QueuedMessage[]; enterAt: number; escAt: number } {
  // What already has its row elsewhere in this frame: a steer (the live copy
  // that was acknowledged, the stored one, or the row the transcript built)
  // and the prompt of the turn a queued message just became. A queued row
  // for any of them is a second drawing of the same words.
  const steerIds = new Set<string>([
    ...(pending?.steers ?? []).flatMap((steer) => (steer.id ? [steer.id] : [])),
    ...p.waitingSubmissions.flatMap((item) => (item.state === 'steered' && item.id ? [item.id] : [])),
    ...drawn.steers.flatMap((steer) => (steer.steerId ? [steer.steerId] : [])),
  ]);
  const becameTurn = (item: { text: string; submittedAt: string }): boolean => drawn.prompt !== undefined && item.text === drawn.prompt
    && (!pending || item.submittedAt <= pending.startedAt);
  const storedQueued = (session.queuedTurns ?? []).filter((item) => !p.takingBack.has(item.id) && !steerIds.has(item.id) && !becameTurn(item));
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
        queueState: p.turn && item.steer === true && pending?.startedAt !== undefined ? 'pause' as const : 'queued' as const,
      })),
    // The bottom row stays until the steer's own row exists in what this
    // frame built (`drawn`), so it never leaves one place before it is in
    // the other. A message that is already a saved message (the pending turn
    // was folded into the transcript) is that row.
    ...p.waitingSubmissions.filter((item) => item.state !== 'steered' && !(item.id && p.takingBack.has(item.id)) && !storedCopy(item)
      && !hasDurableSteer(item, drawn.steers.map((steer) => ({ text: steer.text, ...(steer.steerId ? { id: steer.steerId } : {}) })))
      && !(drawn.materialized && hasDurableSteer(item, pending?.steers ?? [])))
      .map((item) => ({ role: 'user' as const, content: item.text, queueState: item.state, user: true, ...(item.unsteered ? { unsteered: true } : {}) })),
  ];
  // Enter again puts the oldest waiting user message into the chat, when
  // it would (enterAgainSends -- the key asks the same). Esc takes the
  // newest back. With one message they are the same row.
  const waitingUser = (message: { user: boolean; queueState: string }): boolean => message.user && !['steered', 'sending', 'error'].includes(message.queueState);
  const enterAt = p.turn?.sendWaiting && !p.turn.cancelled && !p.turn.draft.trim()
    && enterAgainSends(queuedMessages.filter(waitingUser).map((message) => ({ held: message.queueState === 'pause', ...(message.unsteered ? { unsteered: true } : {}) })))
    ? queuedMessages.findIndex(waitingUser) : -1;
  const escAt = p.turn?.takeBack ? queuedMessages.map(waitingUser).lastIndexOf(true) : -1;
  return { queuedMessages, enterAt, escAt };
}

/** The queued messages as rows under the live answer, each with its status
 * and the keys that act on it. */
export function queuedMessageRows(
  queuedMessages: readonly QueuedMessage[], enterAt: number, escAt: number, inner: number, userRows: (content: string) => readonly string[],
): string[] {
  const liveConversation: string[] = [];
  for (const [queueIndex, message] of queuedMessages.entries()) {
    // Provisional, and so never retired: a queued turn becomes a real user
    // message the moment it is sent, and would then be written a second time.
    // The keys before the note on why it queued: a narrow row drops parts
    // from the end, and what can be done is the part worth keeping. Esc
    // goes first when both do not fit: it is the shorter, and always works.
    const enterKey = queueIndex === enterAt ? [STEER_WORDS.sendNow] : [];
    const escKey = queueIndex === escAt ? [keyHint('takeBack')] : [];
    const statusWith = (keys: readonly string[]): string => {
      const said = keys.map((key) => ` · ${key}`).join('');
      return message.queueState === 'pause' ? `${STEER_WORDS.held}${said}`
        : message.queueState === 'sending' ? 'sending'
          : message.queueState === 'error' ? 'not sent'
            : `queued for next turn${said}${message.unsteered ? ` · ${STEER_WORDS.unsteered}` : ''}`;
    };
    const hintRoom = Math.max(1, inner - 4);
    const roomy = statusWith([...enterKey, ...escKey]);
    const status = terminalCellWidth(roomy) <= hintRoom ? roomy : statusWith([...escKey, ...enterKey]);
    // The speaker changes once, where the queue begins: two rows there, the
    // same break a settled prompt gets. Between queued messages it is one.
    liveConversation.push(...(queueIndex === 0 ? ['', ''] : ['']), ...userRows(message.content), `  ${chalk.dim(`↳ ${fitHint(status, hintRoom)}`)}`);
  }
  return liveConversation;
}

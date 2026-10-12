/** Running one turn: the pending prompt, the sign-in before it, and the worker or in-process turn. */
import Conf from 'conf';
import { stdout as output } from 'node:process';
import chalk from 'chalk';
import type { HarnessSession } from '../../../session/model.js';
import { sessionProviderLabel } from '../../../harness/protocol/labels.js';
import { runSessionTurn } from '../../../turn/session-turn.js';
import { TerminalHarnessPrompter } from '../../../tui/prompter.js';
import { prepareTurn } from '../../../session/attach.js';
import { sessionTranscriptMessages } from '../../../turn/checkpoint.js';
import { signInBeforeUse } from '../harness.js';
import { signInOutcomeSaid } from '../../account.js';
import { INTERRUPTED_TURN_REQUEST } from '../../../turn/failover-prompt.js';
import { runTurnThroughWorker } from '../../../worker/turn-bridge.js';

/** What a turn left for the loop: a notice, and whether Left was pressed to open the board. */
export interface TurnResult { notice?: string; left?: boolean }

/** One turn through the worker (or in process without a terminal), with
 * the sign-in before it and the draft written for it. */
export async function runTimedTurn(
  { config, terminal, lastSeen }: { config: Conf; terminal: TerminalHarnessPrompter | undefined; lastSeen: HarnessSession },
  targetId: string, promptText: string, turn: { echo: boolean; queuedTurnId?: string; turnId: string; submittedAt: number },
): Promise<TurnResult> {
    // The submitted prompt is the prompter's for the whole turn, not a
    // message and not part of any snapshot: it is not a message yet, and
    // put in `messages` it lived somewhere the worker's next snapshot
    // overwrote -- which is what made the message the user had just sent
    // appear and then vanish. See tui/render/pending-prompt.ts. Held from
    // here, so a sign-in before the turn does not hide it either.
    terminal?.submitted(turn.echo && promptText !== INTERRUPTED_TURN_REQUEST ? promptText : undefined);
    // A typed message replaces a turn parked for the quota reset (the
    // worker drops it): said here, under the message, before its answer.
    if (terminal && turn.echo && !turn.queuedTurnId && lastSeen.id === targetId && lastSeen.resumeAt) {
      terminal.activity(chalk.dim('Stopped waiting for the reset · a new message was sent'));
    }
    // Using a provider no account is signed in to is when its sign-in
    // opens -- here, before the turn, so it shows on its own and its
    // outcome stays in the transcript. Nothing signed in at launch.
    // The turn's wait goes up the moment it finishes, taking whatever was
    // typed under the sign-in, so that is never drawn missing between.
    // One that does not sign in: the message was never sent, and goes
    // back to the composer (its line says how the sign-in ended).
    const signedIn = terminal ? await signInBeforeUse(targetId).catch((error: unknown) => {
      if (signInOutcomeSaid(error)) {
        terminal.submitted(undefined);
        if (turn.echo) terminal.restoreDraft(promptText);
      }
      throw error;
    }) : false;
    if (terminal && signedIn) terminal.turnStarting();
    // A draft is written now, because this message is what makes the chat
    // a conversation; the waiting line says what a local model is doing.
    const { state: activeState, active } = await prepareTurn(targetId);
    const activeAccount = active?.accountId ? activeState.accounts.find((item) => item.id === active.accountId)?.label : undefined;
    if (active && terminal) {
      const pending: HarnessSession = {
        ...active,
        messages: sessionTranscriptMessages(active),
        pendingTurn: undefined,
        ...(turn.queuedTurnId
          ? { queuedTurns: active.queuedTurns?.filter((item) => item.id !== turn.queuedTurnId) }
          : {}),
      };
      terminal.render(pending, activeAccount);
      // The worker owns cancellation, steering and the preserve-vs-discard
      // decision on a cancel (worker/session-worker.ts's runTurn), and
      // runTurnThroughWorker rethrows only a genuine failure.
      const outcome = await runTurnThroughWorker(targetId, terminal, promptText, turn);
      return { ...(outcome.notice ? { notice: outcome.notice } : {}), ...(outcome.left ? { left: true } : {}) };
    }
    output.write(`${chalk.dim(`${active ? sessionProviderLabel(active) : 'Provider'} · working…`)}\n`);
    await runSessionTurn(config, targetId, promptText, undefined, {
      persistentTransports: true,
      ...(turn.queuedTurnId ? { queuedTurnId: turn.queuedTurnId } : {}),
    });
    return {};
}


/** The worker's queue: starting a turn, draining notifications, handling `submit`
 * and the queued-turn bookkeeping that keeps two turns from running at once. */
import { randomUUID } from 'node:crypto';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { enqueueSessionTurn } from '../turn/checkpoint.js';
import { takeShellNotifications } from '../agent/session-state.js';
import { sendEvent } from './broadcast-observer.js';
import type { ClientCommand } from './protocol.js';
import type { Socket } from 'node:net';
import type { WorkerContext } from './worker-context.js';

export function createWorkerQueue(ctx: WorkerContext) {
  const { observer, sessionId, agentSession } = ctx;
  const { currentSessionAndAccount, broadcastNotice, broadcastQueueChanged, recordNotifications } = ctx.io;
  /** A background shell finished. A running turn hands it to the model
   * before its next step (run-turn.ts) and needs nothing from here; with no
   * turn running, it is recorded and run as a follow-up turn, whether or not
   * any window is open -- an attached window follows that turn like its own. */
  const deliverNotifications = async (): Promise<void> => {
    try {
      if (!ctx.turnRunning && agentSession.notifications.length) {
        await recordNotifications(takeShellNotifications(agentSession));
        broadcastQueueChanged();
        await drainQueue();
      }
    } catch (error) {
      broadcastNotice(`Could not deliver a background shell's exit: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ctx.idle.scheduleIdleExit();
    }
  };

  /** Starts a turn unless one is already running. Synchronous from the check
   * to the flag, so nothing can slip a second turn in between. */
  const startTurn = (command: Extract<ClientCommand, { type: 'submit' }>): boolean => {
    if (ctx.turnRunning) return false;
    ctx.turnRunning = true;
    ctx.activeQueuedTurnId = command.queuedTurnId;
    void ctx.runTurn(command);
    return true;
  };

  /** Runs the queue's head when it is a notification. A message the user
   * queued is still sent by their window, which prepares what that turn
   * needs locally (a ClikCode Local model) before sending it; a
   * slash command only ever runs there. Anything else at the head is left,
   * and the windows are told the queue changed. */
  const reportDrainFailure = (error: unknown): void => {
    broadcastNotice(`Could not read the queue: ${error instanceof Error ? error.message : String(error)}`);
  };
  const drainQueue = async (): Promise<void> => {
    if (ctx.turnRunning || ctx.draining) return;
    ctx.draining = true;
    try {
      const { session: current } = await currentSessionAndAccount();
      const head = current.queuedTurns?.[0];
      if (!head || head.id === ctx.stalledQueuedTurnId) return;
      if (head.kind !== 'notification') { broadcastQueueChanged(); return; }
      startTurn({ type: 'submit', text: head.text, echo: true, queuedTurnId: head.id });
    } finally {
      ctx.draining = false;
    }
  };

  /** `submit`. A queued turn this worker is already running is followed,
   * not run again; one no longer in the queue already ran. A submit while
   * another turn runs is queued behind it (it used to start a second turn
   * beside the first). */
  const handleSubmit = async (socket: Socket, command: Extract<ClientCommand, { type: 'submit' }>): Promise<void> => {
    // The client already shows the prompt; the snapshot brings it up to date
    // with what has streamed, and the turn's own events carry it from there.
    // `live` is read when the snapshot is sent, not before the state read:
    // what streamed during that read reached this window as events already,
    // and a snapshot older than them took them back off its screen.
    const follow = (): void => {
      void currentSessionAndAccount().then(({ session: current, account }) => observer.snapshotFor(socket, current, account), () => undefined);
    };
    if (command.queuedTurnId) {
      if (command.queuedTurnId === ctx.stalledQueuedTurnId) {
        sendEvent(socket, { type: 'turn-error', message: 'This queued message already failed and could not be taken out of the queue; remove it to continue.' });
        sendEvent(socket, { type: 'waiting-stop' });
        return;
      }
      if (ctx.turnRunning && ctx.activeQueuedTurnId === command.queuedTurnId) { follow(); return; }
      const { session: current, account } = await currentSessionAndAccount();
      if (ctx.turnRunning && ctx.activeQueuedTurnId === command.queuedTurnId) { follow(); return; }
      if (!current.queuedTurns?.some((item) => item.id === command.queuedTurnId)) {
        sendEvent(socket, { type: 'snapshot', session: current, ...(account ? { account } : {}) });
        sendEvent(socket, { type: 'waiting-stop' });
        return;
      }
    }
    // A new message from the user replaces a turn parked for the reset. The
    // window that sent it says so, in a line before its answer (a notice
    // from here was drawn under that answer).
    if (!command.queuedTurnId) await ctx.resumeWaiter.cancel();
    if (startTurn(command)) return;
    let queuedTurnId = command.queuedTurnId;
    if (!queuedTurnId) {
      queuedTurnId = randomUUID();
      const latest = await readState({ transcripts: [sessionId] });
      const found = latest.sessions.find((item) => item.id === sessionId);
      if (!found) throw new Error(`AI session "${sessionId}" was not found`);
      const submittedAt = new Date().toISOString();
      enqueueSessionTurn(found, { id: queuedTurnId, text: command.text.trim(), submittedAt }, submittedAt);
      await writeState(latest);
    }
    sendEvent(socket, { type: 'submit-queued', queuedTurnId });
    broadcastQueueChanged();
    // The window follows the running turn until it ends; this brings it up
    // to date with what has streamed.
    follow();
  };
  return { startTurn, drainQueue, handleSubmit, deliverNotifications, reportDrainFailure };
}

export type WorkerQueue = ReturnType<typeof createWorkerQueue>;

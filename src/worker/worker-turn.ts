/** One turn of the worker: run it for the attached windows, and settle how it
 * ended -- cancelled, failed or finished -- before the next one may start. */
import { randomUUID } from 'node:crypto';
import { isTurnCancelled, turnCancelledError } from '../agent/cancellation.js';
import { STOPPED } from '../harness/protocol/wording.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { beginTurnClock, endTurnClock, markTurn } from '../runtime/turn-latency.js';
import { isUsageExhaustedMessage } from '../turn/usage-exhausted.js';
import { runSessionTurn } from '../turn/session-turn.js';
import { LiveTurnInputBroker } from '../turn/live-input.js';
import { discardInterruptedTurn, markFailedTurn, preserveInterruptedTurn } from '../turn/turn-journal.js';
import { releaseMcp } from '../agent/mcp/manager.js';
import { consumeQueuedTurn } from './consume-queued.js';
import { sendEvent } from './broadcast-observer.js';
import type { ClientCommand } from './protocol.js';
import type { WorkerContext } from './worker-context.js';

type SubmitCommand = Extract<ClientCommand, { type: 'submit' }>;

export function createTurnRunner(ctx: WorkerContext) {
  const { observer, sessionId, config, agentSession } = ctx;
  const { currentSessionAndAccount, broadcastNotice } = ctx.io;

  /** A turn that was stopped: something worth keeping (text or tool activity
   * already streamed) is preserved as an interrupted turn a future turn can
   * carry on from; nothing yet is simply discarded, as if it was never sent. */
  const settleCancelledTurn = async (command: SubmitCommand): Promise<void> => {
    // Same distinction interactive.ts's own catch makes today: something
    // worth keeping (text or tool activity already streamed) is
    // preserved as an interrupted turn a future turn can carry on from;
    // nothing yet is simply discarded, as if it was never sent.
    // Text or a tool row is an answer. Thinking, and a notice, are not:
    // the prompt comes back when the client asked, and the turn is not
    // kept. An answer is kept even when the client asked for the draft.
    const answered = observer.turnHasAnswer;
    // The draft goes back to the window that took it back, and only
    // there: every other window is only told the turn stopped.
    const restoreTo = answered ? undefined : ctx.activeRestoreDraft;
    if (answered) await preserveInterruptedTurn(sessionId, command.text, observer.liveResponseText, true);
    else await discardInterruptedTurn(sessionId, command.text);
    observer.broadcast({ type: 'notice', message: STOPPED }, restoreTo);
    if (restoreTo && !restoreTo.destroyed) {
      sendEvent(restoreTo, { type: 'restore-draft', text: command.text });
      sendEvent(restoreTo, { type: 'notice', message: `${STOPPED} · draft restored` });
    }
  };

  /** A turn that failed: journaled as failed, told to the windows, and its queue entry taken out. */
  const settleFailedTurn = async (command: SubmitCommand, error: unknown, resumed: boolean): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    await markFailedTurn(sessionId, command.text).catch((saveError: unknown) => {
      lifecycle('worker.turn.failed-journal-error', { message: saveError instanceof Error ? saveError.message : String(saveError) });
    });
    observer.broadcast({ type: 'turn-error', message });
    // The one retry after the reset ran out too: it is not parked again.
    if (resumed && isUsageExhaustedMessage(message)) broadcastNotice('Still out of usage after the reset · not retrying again');
    // A queued turn is consumed once its checkpoint starts; one that
    // failed before that is still at the head, and would be run again
    // straight after this -- and fail the same way, for ever. When it
    // cannot be taken out, it is not run again by this worker.
    if (command.queuedTurnId) {
      await consumeQueuedTurn(sessionId, command.queuedTurnId).catch((consumeError: unknown) => {
        ctx.stalledQueuedTurnId = command.queuedTurnId;
        broadcastNotice(`A queued message failed and could not be taken out of the queue (${consumeError instanceof Error ? consumeError.message : String(consumeError)}); it will not be run again until it is removed.`);
      });
    }
  };

  /** After the turn, success or not: the turn's own state cleared, the windows
   * told it ended, and whatever is owed or queued next started. */
  const finalizeTurn = async (turnId: string, turnStarted: number, turnOutcome: string, liveInput: LiveTurnInputBroker, submissions: Set<Promise<void>>): Promise<void> => {
    liveInput.close();
    ctx.activeController = undefined;
    ctx.activeLiveInput = undefined;
    ctx.activeSubmissions = undefined;
    ctx.activeRestoreDraft = undefined;
    ctx.stopAnnounced = false;
    // A message typed as the turn ended may still be on its way into the
    // queue (the broker falls back to it once steering has closed). The
    // final snapshot, the queue drained below and its answer to the window
    // must all come after it lands: otherwise the window was told the turn
    // was over, cleared the message's row, redrew from a queue that did
    // not have it yet -- and the message vanished until the next key.
    await Promise.allSettled([...submissions]);
    // What background work this turn superseded did, now that the turn's own
    // save (which rewrites the transcript) is done.
    await ctx.vendorBackground.saveSuperseded().catch(() => undefined);
    // The terminal event goes out whatever the read of the conversation did:
    // a window waits on it, and a worker that never sent it would hold the
    // turn open on every window for ever.
    const ended = await currentSessionAndAccount().catch(() => undefined);
    ctx.turnRunning = false;
    observer.endTurn(ended?.session, ended?.account, turnOutcome === 'cancelled');
    lifecycle('worker.turn.end', { outcome: turnOutcome, ms: Date.now() - turnStarted });
    endTurnClock(turnId);
    ctx.idle.vendorUsed();
    ctx.activeQueuedTurnId = undefined;
    // Vendor work that arrived while this turn was finishing.
    ctx.vendorBackground.userTurnEnded();
    // Everyone left while it ran: now nothing is using what it started.
    if (observer.attachedCount === 0) void releaseMcp();
    // Shells that finished after the turn's last step, then whatever is
    // queued next; either may start the next turn at once.
    if (agentSession.notifications.length) void ctx.queue.deliverNotifications();
    else void ctx.queue.drainQueue().catch(ctx.queue.reportDrainFailure).finally(ctx.idle.scheduleIdleExit);
    ctx.idle.scheduleIdleExit();
    // Parked while this turn ran (another window's "Wait for reset").
    void ctx.resumeWaiter.check();
  };

  return async (command: SubmitCommand): Promise<void> => {
    ctx.turnRunning = true;
    const turnStarted = Date.now();
    let turnOutcome = 'completed';
    lifecycle('worker.turn.start', { queued: Boolean(command.queuedTurnId), clients: observer.attachedCount });
    // The window's clock when it sent one; else this turn is timed from here
    // (a queued notification, a scripted send).
    const turnId = command.turnId ?? randomUUID();
    beginTurnClock({ turnId, ...(command.submittedAt !== undefined ? { startedAt: command.submittedAt } : {}) });
    if (command.submittedAt === undefined) markTurn('submit');
    markTurn('accepted', { queued: Boolean(command.queuedTurnId) });
    const resumed = ctx.resumingTurn;
    ctx.resumingTurn = false;
    if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
    ctx.idleTimer = undefined;
    const controller = new AbortController();
    const liveInput = new LiveTurnInputBroker();
    const submissions = new Set<Promise<void>>();
    ctx.activeController = controller;
    ctx.activeLiveInput = liveInput;
    ctx.activeSubmissions = submissions;
    // A Stop that arrived before this turn started: applied now, and the turn
    // ends through the ordinary cancelled path.
    const earlyStop = ctx.pendingCancel;
    ctx.pendingCancel = undefined;
    if (earlyStop) {
      if (earlyStop.restoreDraft) ctx.activeRestoreDraft = earlyStop.restoreDraft;
      controller.abort();
    }
    // startWaiting/stopWaiting bracket the call the same way interactive.ts's
    // own runInteractiveTurn does today -- the turn itself never calls
    // either, by design (see turn/observer.ts): they are the ORCHESTRATOR
    // signalling "a turn is in flight", not something a turn declares about
    // itself. In the worker model the worker is that orchestrator now, and
    // stopWaiting is the one event every client needs regardless of outcome
    // to know a `submit` it sent has actually finished -- broadcast in
    // `finally`, covering success, a caught failure, and cancellation alike.
    observer.startTurn('thinking', command.text);
    try {
      // A background turn's record still being saved: this turn's checkpoint
      // would read the conversation without it and then write it back whole.
      await ctx.vendorBackground.settled();
      if (controller.signal.aborted) throw turnCancelledError();
      await runSessionTurn(config, sessionId, command.text, controller.signal, {
        persistentTransports: true,
        prompter: observer,
        liveInput,
        liveSettings: ctx.liveSettings,
        ...(command.queuedTurnId ? { queuedTurnId: command.queuedTurnId } : {}),
      });
    } catch (error) {
      const cancelled = isTurnCancelled(error);
      turnOutcome = cancelled ? 'cancelled' : `error: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`;
      try {
        if (cancelled) await settleCancelledTurn(command);
        else await settleFailedTurn(command, error, resumed);
      } catch (settleError) {
        // Settling is bookkeeping; the turn's end must still be told.
        observer.broadcast({ type: 'turn-error', message: settleError instanceof Error ? settleError.message : String(settleError) });
      }
    } finally {
      // Saved (answered, failed or cancelled and settled): what a snapshot sent from here on holds is final.
      observer.turnRecordFinal();
      await finalizeTurn(turnId, turnStarted, turnOutcome, liveInput, submissions);
    }
  };
}

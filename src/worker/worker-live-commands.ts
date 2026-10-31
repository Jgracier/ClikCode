/** The commands that act on the running turn or the queue behind it: stop it,
 * steer a message into it, send a queued one now, take one out of the queue. */
import { randomUUID } from 'node:crypto';
import { existingSessionAgents } from '../agent/background-agents.js';
import { isClikCodeAgent } from '../session/route.js';
import type { Socket } from 'node:net';
import { lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { consumeSessionTurn, enqueueSessionTurn } from '../turn/checkpoint.js';
import { deliverTyped } from '../turn/send-mode.js';
import { closePersistentTransport, persistentWorkRunning, reapPersistentCommands } from '../turn/vendor-process.js';
import { hasHeldVendorProcess, stopHeldVendorProcess } from '../harness/transport/native/held-vendor.js';
import { sendEvent } from './broadcast-observer.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { subAgentSteerPlan, type SubAgentRef } from '../harness/protocol/activity-normalize.js';
import { cancelOriginFields, type CancelOrigin, type ClientCommand } from './protocol.js';
import type { WorkerContext } from './worker-context.js';

/** How long a Stop is given to end the turn before it is ended by force. Kept: the user asked
 * for this stop, and abort is cooperative -- work that never reaches its abort check (a sign-in
 * prompt, a tool that ignores the signal) would leave every window "stopping" with no way out
 * but a second press nobody was told about. It only ends the turn's own processes, after a
 * Stop the user pressed; processes with their own wind-down (a vendor child's 2s cancel settle,
 * a held process's exit wait) have ended by then. */
const HARD_STOP_AFTER_MS = 8000;

/** A Stop that is the user's own plain key. A script's abort signal or a programmatic stop is a decision already made. */
function stopHoldsForAgents(command: { origin?: CancelOrigin }): boolean {
  const trigger = command.origin?.trigger;
  return trigger === undefined || trigger === 'esc' || trigger === 'ctrl-c' || trigger === 'editor-stop';
}

function subAgentStopNote(labels: readonly string[]): string {
  const named = labels.slice(0, 4).map((label) => `"${label.slice(0, 50)}"`).join(', ') + (labels.length > 4 ? ` and ${labels.length - 4} more` : '');
  return `Stop held: ${labels.length} sub-agent${labels.length === 1 ? ' is' : 's are'} running (${named}), and stopping the turn would end ${labels.length === 1 ? 'it' : 'them'}. Press Esc or Ctrl+C again to stop anyway; otherwise nothing was interrupted. Messages you type still steer.`;
}

/** What a Stop that ended background commands says: each by pid. */
export function stoppedCommandsNote(commands: readonly { pid: number; label: string }[]): string {
  const named = commands.slice(0, 4).map((item) => `${item.pid} "${item.label.replace(/\s+/g, ' ').trim().slice(0, 60)}"`).join(', ') + (commands.length > 4 ? ` and ${commands.length - 4} more` : '');
  return `Stopped ${commands.length} background command${commands.length === 1 ? '' : 's'} and their process groups: ${named}.`;
}

export function createLiveCommands(ctx: WorkerContext) {
  const { observer, sessionId } = ctx;
  const { currentSessionAndAccount, note, broadcastQueueChanged, showEveryWindow } = ctx.io;

  /** Take a message out of the queue. */
  const handleUnqueue = async (socket: Socket, command: Extract<ClientCommand, { type: 'unqueue' }>): Promise<void> => {
    // Always answered: the window waits on this to know whether it may stop
    // the running turn for its "send now".
    const answer = (outcome: 'removed' | 'running' | 'gone' | 'error', message?: string): void => {
      sendEvent(socket, { type: 'unqueued', id: command.id, outcome, ...(message ? { message } : {}) });
    };
    if (ctx.activeQueuedTurnId === command.id) { answer('running'); return; }
    // While a turn runs, its queue is the turn's: taking one back goes through it, so a message is
    // never both taken back and put into the turn. `running`: it is going into the turn this moment.
    const live = ctx.activeLiveInput;
    try {
      if (live) {
        const outcome = await live.takeBack(command.id);
        if (outcome !== 'removed') { answer(outcome); return; }
      } else {
        const state = await readState({ transcripts: [sessionId] });
        const found = state.sessions.find((item) => item.id === sessionId);
        if (!found || !consumeSessionTurn(found, command.id)) { answer('gone'); return; }
        await writeState(state);
      }
    } catch (error) {
      answer('error', error instanceof Error ? error.message : String(error));
      return;
    }
    answer('removed');
    observer.broadcast({ type: 'queue-changed' });
    // Every window drops it now, a turn running or not.
    void currentSessionAndAccount().then(({ session: current, account }) => observer.render(current, account)).catch(quiet('worker/worker-live-commands'));
    return;
  };

  const handleSendQueued = async (socket: Socket, _command: Extract<ClientCommand, { type: 'send-queued' }>): Promise<void> => {
    // Enter again: the oldest message the user queued is offered to the running turn now. The vendor takes
    // it if it can without interrupting anything; if it cannot yet, it stays queued and goes in at the turn's
    // next opening. Nothing is cut and the turn is not cancelled, so a sub-agent it started keeps running.
    // A command or a notice stays for the turn's end.
    const liveInput = ctx.activeLiveInput;
    if (!liveInput) return;
    const handled = (async () => {
      try {
        const result = await liveInput.sendNow();
        if (!result) return;
        sendEvent(socket, {
          type: 'submission', id: result.submission.id, disposition: result.steered ? 'steered' : 'queued',
          ...(result.steered ? observer.steerOrder(result.submission.id) ?? {} : {}),
        });
        // The entry changed (marked to go in, or gone into the turn): every window redraws the queue.
        broadcastQueueChanged();
        if (result.steered) showEveryWindow();
      } catch (error) {
        note(`Could not send: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    ctx.activeSubmissions?.add(handled);
    await handled;
    return;
  };

  /** Told once per stopped turn: every window says "stopping", and the one
   * whose Esc asked for its message back says "editing". */
  const announceStopping = (restoreTo: Socket | undefined): void => {
    if (ctx.stopAnnounced) return;
    ctx.stopAnnounced = true;
    observer.broadcast({ type: 'stopping' }, restoreTo);
    if (restoreTo) sendEvent(restoreTo, { type: 'stopping', restoreDraft: true });
  };

  /** Ends a stopping turn that did not end: what it may be waiting on is
   * killed or refused, and the turn is ended as stopped. */
  const hardStop = async (command: { origin?: CancelOrigin } = {}): Promise<void> => {
    lifecycle('worker.cancel', { ...originFields(command), stopped: 'forced' });
    observer.rejectPendingRequests();
    await Promise.allSettled([closePersistentTransport(sessionId), stopHeldVendorProcess(sessionId)]);
    ctx.forceStop?.();
  };

  const originFields = cancelOriginFields;
  /** The turn whose Stop was held back for running sub-agents; a second Stop on it confirms, for as
   * long as it runs (no clock: the sub-agents are what is being asked about, and they are listed). */
  let agentStopAsked: AbortController | undefined;
  const handleCancel = async (socket: Socket, command: Extract<ClientCommand, { type: 'cancel' }>): Promise<void> => {
    // The vendor's work is over and only the record is being saved: nothing is
    // left to stop, and the turn must not be labelled stopped.
    if (ctx.activeController && ctx.turnWorkDone) {
      lifecycle('worker.cancel', { ...originFields(command), stopped: 'nothing (turn work finished)' });
      sendEvent(socket, { type: 'stop-done', nothing: true });
      return;
    }
    if (ctx.activeController) {
      // A plain Stop (Esc, Ctrl+C, the editor's button) must not end running sub-agents: a vendor
      // harness cancels them with the turn. The user is told, and a second Stop confirms.
      const agentsOpen = observer.openAgentCalls();
      if (agentsOpen.length && stopHoldsForAgents(command) && !ctx.stopAnnounced) {
        if (agentStopAsked !== ctx.activeController) {
          agentStopAsked = ctx.activeController;
          lifecycle('worker.cancel', { ...originFields(command), stopped: 'held: sub-agents running', agents: agentsOpen.map((agent) => agent.label).join(' | ').slice(0, 300) });
          note(subAgentStopNote(agentsOpen.map((agent) => agent.label)));
          return;
        }
      }
      agentStopAsked = undefined;
      lifecycle('worker.cancel', { ...originFields(command), stopped: 'turn' });
      const repeated = ctx.stopAnnounced && ctx.activeController.signal.aborted;
      // A repeated Stop must not take back the first's draft decision.
      if (command.restoreDraft && !ctx.stopAnnounced) ctx.activeRestoreDraft = socket;
      announceStopping(ctx.activeRestoreDraft);
      ctx.activeController.abort();
      // A Stop the turn does not honour (a held vendor's release, a sign-in,
      // work that ignores the abort) must not leave the window stopping: a
      // second Stop, or the wait running out, ends it by force.
      if (repeated) await hardStop(command);
      else if (!ctx.stopEscalation) {
        const controller = ctx.activeController;
        ctx.stopEscalation = setTimeout(() => {
          ctx.stopEscalation = undefined;
          if (ctx.activeController === controller) void hardStop();
        }, HARD_STOP_AFTER_MS);
        ctx.stopEscalation.unref?.();
      }
      return;
    }
    // A submit accepted but not yet a turn: the Stop is the turn's, and is
    // applied the moment it starts (worker-turn.ts).
    if (ctx.submitsInFlight > 0) {
      lifecycle('worker.cancel', { ...originFields(command), stopped: 'pending turn' });
      const pending = ctx.pendingCancel ?? (ctx.pendingCancel = { restoreDraft: command.restoreDraft ? socket : undefined, askers: new Set() });
      pending.askers.add(socket);
      announceStopping(pending.restoreDraft);
      return;
    }
    // No turn: what the window shows running is the vendor's background
    // work (its tasks, sub-agents, or a follow-up between turns), and Stop
    // stops that too.
    if (hasHeldVendorProcess(sessionId)) {
      lifecycle('worker.cancel', { ...originFields(command), stopped: 'held vendor' });
      announceStopping(undefined);
      try { await stopHeldVendorProcess(sessionId); } finally { if (!ctx.turnRunning) ctx.stopAnnounced = false; observer.broadcast({ type: 'stop-done' }); }
      return;
    }
    if (ctx.vendorBackground.busy || await persistentWorkRunning(sessionId)) {
      announceStopping(undefined);
      try {
        // The background commands go by pid, with their process groups: closing the vendor alone left a spinning
        // command running for hours (2026-10-30). What was ended is logged and said.
        const reaped = await reapPersistentCommands(sessionId, 'all', 'stopped by the user').catch(() => []);
        lifecycle('worker.cancel', { ...originFields(command), stopped: 'vendor background work', killed: reaped.map(({ command: item, kill }) => `${item.pid} (${kill.how}) ${item.label}`.slice(0, 200)).join(' | ') || 'no commands' });
        if (reaped.length) note(stoppedCommandsNote(reaped.map(({ command: item }) => item)));
        await Promise.all([closePersistentTransport(sessionId), stopHeldVendorProcess(sessionId)]);
      } finally { if (!ctx.turnRunning) ctx.stopAnnounced = false; observer.broadcast({ type: 'stop-done' }); }
      return;
    }
    // Else a turn parked for the reset, if there is one. Said out loud
    // either way: the window that asked is waiting to hear that it is over.
    lifecycle('worker.cancel', { ...originFields(command), stopped: ctx.resumeWaiter.pending ? 'reset wait' : 'nothing' });
    try { await ctx.resumeWaiter.cancel(); } finally { sendEvent(socket, { type: 'stop-done', nothing: true }); }
    return;
  };

  const handleSteer = async (socket: Socket, command: Extract<ClientCommand, { type: 'steer' }>): Promise<void> => {
    const answer = (disposition: 'steered' | 'queued' | 'error', message?: string): void => {
      if (command.id) sendEvent(socket, { type: 'submission', id: command.id, disposition, ...(message ? { message } : {}), ...(disposition === 'steered' ? observer.steerOrder(command.id) ?? {} : {}) });
    };
    // The turn ended between the client's Enter and this arriving. This used
    // to `return` -- and the message was simply gone. Nothing is running to
    // steer into, so it is queued durably and the interactive loop sends it
    // as the next turn, exactly as a queued message always is.
    if (!ctx.activeLiveInput) {
      try {
        const state = await readState({ transcripts: [sessionId] });
        const session = state.sessions.find((item) => item.id === sessionId);
        if (!session) throw new Error('conversation not found');
        const submittedAt = new Date().toISOString();
        enqueueSessionTurn(session, { id: command.id ?? randomUUID(), text: command.text.trim(), submittedAt }, submittedAt);
        await writeState(state);
        answer('queued');
        broadcastQueueChanged();
      } catch (error) {
        answer('error', error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const liveInput = ctx.activeLiveInput;
    const handled = (async () => {
      try {
        // `/send queue` is the user's global choice, read as the message
        // arrives so a change mid-turn applies to the next one typed.
        const settings = await readState({ transcripts: [] }).then((state) => state.globalSettings, () => undefined);
        const result = await deliverTyped(liveInput, command.text, command.id, settings);
        answer(result.disposition === 'steered' ? 'steered' : 'queued');
        // Every window shows the queue, not only the one that typed it.
        if (result.disposition !== 'steered') broadcastQueueChanged();
        else showEveryWindow();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        answer('error', message);
        if (!command.id) note(`Could not send: ${message}`);
      }
    })();
    ctx.activeSubmissions?.add(handled);
    await handled;
    return;
  };
  /** `steer-subagent`: what the harness allows (docs/SUBAGENTS.md), and nothing else. */
  const handleSteerSubagent = async (socket: Socket, command: Extract<ClientCommand, { type: 'steer-subagent' }>): Promise<void> => {
    const refuse = (message: string): void => {
      if (command.id) sendEvent(socket, { type: 'submission', id: command.id, disposition: 'error', message });
      else note(message);
    };
    const { session } = await currentSessionAndAccount();
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (isClikCodeAgent(session)) {
      const agents = existingSessionAgents(ctx.agentSession);
      const id = command.agentId;
      if (!agents || !id) { refuse('This sub-agent has no running background session.'); return; }
      const result = await agents.send(id, command.text);
      if (result.isError) refuse(result.output);
      else if (command.id) sendEvent(socket, { type: 'submission', id: command.id, disposition: 'steered' });
      return;
    }
    const ref: SubAgentRef = {
      id: command.parentId, label: command.label ?? command.parentId, status: 'running', harness: harness?.command ?? 'unknown',
      ...(command.agentId ? { agentId: command.agentId } : {}),
      read: harness?.subagents?.read ?? 'none', steer: harness?.subagents?.steer ?? 'none',
    };
    const plan = subAgentSteerPlan(ref, harness?.displayName ?? 'This harness', ctx.activeLiveInput !== undefined, command.text);
    if ('refuse' in plan) { refuse(plan.refuse); return; }
    await handleSteer(socket, { type: 'steer', text: plan.steer, ...(command.id ? { id: command.id } : {}) });
  };
  return { handleUnqueue, handleSendQueued, handleCancel, handleSteer, handleSteerSubagent };
}

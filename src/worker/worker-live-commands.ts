/** The commands that act on the running turn or the queue behind it: stop it,
 * steer a message into it, send a queued one now, take one out of the queue. */
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { consumeSessionTurn, enqueueSessionTurn } from '../turn/checkpoint.js';
import { deliverTyped } from '../turn/send-mode.js';
import { closePersistentTransport, persistentWorkRunning } from '../turn/vendor-process.js';
import { hasHeldVendorProcess, stopHeldVendorProcess } from '../harness/transport/native/held-vendor.js';
import { sendEvent } from './broadcast-observer.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { subAgentSteerPlan, type SubAgentRef } from '../harness/protocol/activity-normalize.js';
import { cancelOriginFields, type CancelOrigin, type ClientCommand } from './protocol.js';
import type { WorkerContext } from './worker-context.js';

/** How long a Stop is given to end the turn before it is ended by force. */
const HARD_STOP_AFTER_MS = 8000;

/** How long after a held Stop a second one counts as the user's confirmation. */
const STOP_CONFIRM_WINDOW_MS = 30_000;

/** A Stop that is the user's own plain key. A script's abort signal or a programmatic stop is a decision already made. */
export function stopHoldsForAgents(command: { origin?: CancelOrigin }): boolean {
  const trigger = command.origin?.trigger;
  return trigger === undefined || trigger === 'esc' || trigger === 'ctrl-c' || trigger === 'editor-stop';
}

export function subAgentStopNote(labels: readonly string[]): string {
  const named = labels.slice(0, 4).map((label) => `"${label.slice(0, 50)}"`).join(', ') + (labels.length > 4 ? ` and ${labels.length - 4} more` : '');
  return `Stop held: ${labels.length} sub-agent${labels.length === 1 ? ' is' : 's are'} running (${named}), and stopping the turn would end ${labels.length === 1 ? 'it' : 'them'}. Press Esc or Ctrl+C again within 30s to stop anyway; otherwise nothing was interrupted. Messages you type still steer.`;
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
    // One the running turn is holding to steer in must not be sent now;
    // one already on its way into the turn is not the queue's any more.
    if (ctx.activeLiveInput?.withdraw(command.id) === false) { answer('running'); return; }
    try {
      const state = await readState({ transcripts: [sessionId] });
      const found = state.sessions.find((item) => item.id === sessionId);
      if (!found || !consumeSessionTurn(found, command.id)) { answer('gone'); return; }
      await writeState(state);
    } catch (error) {
      answer('error', error instanceof Error ? error.message : String(error));
      return;
    }
    answer('removed');
    observer.broadcast({ type: 'queue-changed' });
    // Every window drops it now, a turn running or not.
    void currentSessionAndAccount().then(({ session: current, account }) => observer.render(current, account)).catch(() => undefined);
    return;
  };

  const handleSendQueued = async (socket: Socket, command: Extract<ClientCommand, { type: 'send-queued' }>): Promise<void> => {
    // Enter again. The oldest message the user queued goes into this turn
    // now: at once where the vendor takes a steer without harm, otherwise it
    // cuts the one call it was waiting for. The turn is not cancelled, so a
    // sub-agent it started keeps running. A command or a notice stays for the turn's end.
    const answer = (disposition: 'steered' | 'queued' | 'error', id?: string, message?: string, unsteered?: boolean): void => {
      if (id) sendEvent(socket, { type: 'submission', id, disposition, ...(message ? { message } : {}), ...(unsteered ? { unsteered } : {}), ...(disposition === 'steered' ? observer.steerOrder(id) ?? {} : {}) });
    };
    if (!ctx.activeLiveInput) return;
    const liveInput = ctx.activeLiveInput;
    let item: { id: string; text: string } | undefined;
    let entry: NonNullable<Parameters<typeof enqueueSessionTurn>[1]> | undefined;
    try {
      const state = await readState({ transcripts: [sessionId] });
      const session = state.sessions.find((entry) => entry.id === sessionId);
      const queued = session?.queuedTurns?.find((entry) => entry.kind !== 'command' && entry.kind !== 'notification');
      if (!session || !queued) return;
      // The turn is holding it for a quiet moment: Enter is the user saying
      // not to wait, so it goes in now and the call in the way is cut.
      if (liveInput.holding(queued.id)) {
        liveInput.force(queued.id);
        answer('queued', queued.id);
        return;
      }
      if (!consumeSessionTurn(session, queued.id)) return;
      await writeState(state);
      item = { id: queued.id, text: queued.text };
      entry = queued;
    } catch (error) {
      answer('error', undefined, error instanceof Error ? error.message : String(error));
      return;
    }
    if (!item) return;
    const queuedItem = item;
    observer.broadcast({ type: 'queue-changed' });
    const handled = (async () => {
      try {
        const result = await liveInput.submit(queuedItem.text, queuedItem.id, { queue: false });
        if (result.disposition === 'queued') liveInput.force(queuedItem.id);
        answer(result.disposition === 'steered' ? 'steered' : 'queued', queuedItem.id, undefined, result.unsteered);
        if (result.disposition !== 'steered') broadcastQueueChanged();
        else showEveryWindow();
        void result.landed?.then((steered) => { if (steered) broadcastQueueChanged(); });
      } catch (error) {
        // The queued copy was consumed above: put it back, or the message is gone.
        if (entry) {
          const restore = entry;
          await readState({ transcripts: [sessionId] }).then(async (state) => {
            const session = state.sessions.find((value) => value.id === sessionId);
            if (!session) return;
            enqueueSessionTurn(session, restore, new Date().toISOString());
            await writeState(state);
          }).catch(() => undefined);
          broadcastQueueChanged();
        }
        answer('error', queuedItem.id, error instanceof Error ? error.message : String(error));
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
  /** The Stop that was held back for running sub-agents; a second one on the same turn confirms it. */
  let agentStopAsked: { controller: AbortController; at: number } | undefined;
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
        const asked = agentStopAsked;
        if (!asked || asked.controller !== ctx.activeController || Date.now() - asked.at > STOP_CONFIRM_WINDOW_MS) {
          agentStopAsked = { controller: ctx.activeController, at: Date.now() };
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
      lifecycle('worker.cancel', { ...originFields(command), stopped: 'vendor background work' });
      announceStopping(undefined);
      try { await closePersistentTransport(sessionId); } finally { if (!ctx.turnRunning) ctx.stopAnnounced = false; observer.broadcast({ type: 'stop-done' }); }
      return;
    }
    // Else a turn parked for the reset, if there is one. Said out loud
    // either way: the window that asked is waiting to hear that it is over.
    lifecycle('worker.cancel', { ...originFields(command), stopped: ctx.resumeWaiter.pending ? 'reset wait' : 'nothing' });
    try { await ctx.resumeWaiter.cancel(); } finally { sendEvent(socket, { type: 'stop-done', nothing: true }); }
    return;
  };

  const handleSteer = async (socket: Socket, command: Extract<ClientCommand, { type: 'steer' }>): Promise<void> => {
    const answer = (disposition: 'steered' | 'queued' | 'error', message?: string, unsteered?: boolean): void => {
      if (command.id) sendEvent(socket, { type: 'submission', id: command.id, disposition, ...(message ? { message } : {}), ...(unsteered ? { unsteered } : {}), ...(disposition === 'steered' ? observer.steerOrder(command.id) ?? {} : {}) });
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
        answer(result.disposition === 'steered' ? 'steered' : 'queued', undefined, result.unsteered);
        // Every window shows the queue, not only the one that typed it.
        if (result.disposition !== 'steered') broadcastQueueChanged();
        else showEveryWindow();
        // Held for the next pause, then steered in: out of the queue and
        // into the turn, on every window.
        void result.landed?.then((steered) => { if (steered) broadcastQueueChanged(); });
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

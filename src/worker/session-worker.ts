/** The worker process itself: one per active conversation, owning turn
 * execution and exiting on its own once genuinely idle and unwatched.
 *
 * Spawned detached (`spawnSessionWorker` in client.ts), with no TTY of its
 * own -- everything here operates on HarnessSession/HarnessState, never a
 * terminal, which is what makes "a client disconnects" an ordinary event
 * instead of something to survive with signal-ignoring tricks the way the
 * single-process design this replaces needed (see the SIGHUP/SIGINT block
 * this is meant to eventually make deletable, commands/ai/interactive.ts).
 */
import { isTurnCancelled } from '../agent/cancellation.js';
import { STOPPED } from '../harness/protocol/wording.js';
import { spawn } from 'node:child_process';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { idleDecision, startsSuccessor, vendorIdleDecision } from './idle-decisions.js';
import { createResumeWaiter } from './resume-wait.js';
import { INTERRUPTED_TURN_REQUEST } from '../turn/failover-prompt.js';
import { isUsageExhaustedMessage } from '../turn/usage-exhausted.js';
import { createServer, type Socket } from 'node:net';
import { hasHeldVendorProcess, whenHeldVendorGone } from '../harness/transport/native/held-vendor.js';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import Conf from 'conf';
import { runSessionTurn } from '../turn/session-turn.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { consumeSessionTurn, enqueueSessionTurn } from '../turn/checkpoint.js';
import { consumeQueuedTurn } from './consume-queued.js';
import { randomUUID } from 'node:crypto';
import { LiveTurnInputBroker } from '../turn/live-input.js';
import { deliverTyped } from '../turn/send-mode.js';
import { CLIKCODE_NOTICE_TAG } from '../session/clikcode-notice.js';
import { closePersistentTransport, hasPersistentTransport, persistentWorkRunning, setVendorBackgroundTurnHandler } from '../turn/vendor-process.js';
import { discardInterruptedTurn, markFailedTurn, preserveInterruptedTurn } from '../turn/turn-journal.js';
import { BroadcastObserver, sendEvent } from './broadcast-observer.js';
import { createVendorBackgroundRunner } from './vendor-background.js';
import { separateFromForeground } from './own-scope.js';
import { FrameDecoder, type ClientCommand } from './protocol.js';
import { disposeSessionState, formatShellNotifications, runningShellCount, sessionState, takeShellNotifications, type ShellNotification } from '../agent/session-state.js';
import { stopBackgroundShell } from '../agent/tools/bash.js';
import { stateDirectory } from '../session/store/paths.js';
import { prepareMcp, releaseMcp } from '../agent/mcp/manager.js';
import { isClikCodeAgent, isGatewayService } from '../session/route.js';
import { gatewayModels } from '../gateway/models.js';
import { routeMcpServers } from '../gateway/mcp.js';
import { generateWorkerToken, removeWorkerRecord, socketPathFor, takeConversation, workerIsReachable, writeWorkerRecord, currentWorkerBuild, type ConversationHold } from './registry.js';

/** No attached client and no turn running, for this long: the worker exits
 * on its own rather than living forever the way the process it replaces
 * did. Generous enough that a flaky reconnect (the original SIGHUP/SIGINT
 * problem this whole design fixes more robustly) has plenty of time to
 * happen without racing a shutdown; short enough that a genuinely abandoned
 * session does not sit as dead weight for days the way the zombie processes
 * that motivated this design did. CLIKCODE_WORKER_IDLE_EXIT_MS overrides it
 * for tests that need to watch a worker decide to exit. */
const IDLE_EXIT_MS = Number(process.env.CLIKCODE_WORKER_IDLE_EXIT_MS) > 0 ? Number(process.env.CLIKCODE_WORKER_IDLE_EXIT_MS) : 30 * 60 * 1000;
/** How often an idle worker checks whether a rebuild replaced its entry.
 * CLIKCODE_WORKER_BUILD_WATCH_MS overrides it for tests. */
const BUILD_WATCH_MS = Number(process.env.CLIKCODE_WORKER_BUILD_WATCH_MS) > 0 ? Number(process.env.CLIKCODE_WORKER_BUILD_WATCH_MS) : 15_000;

/** A background shell keeps an otherwise idle worker alive -- its exit is
 * owed to the model -- but not for ever: this long after it started, with
 * nobody attached and no turn running, it is stopped, and the model is told
 * so like any other exit. */
const ABANDONED_SHELL_MS = 24 * 60 * 60 * 1000;
/** How often a worker that reached its idle time looks again at vendor work
 * still running between turns (a process's exit gives no event to another
 * process's parent). */
const VENDOR_WORK_RECHECK_MS = 30 * 1000;
/** No turn for this long: the persistent vendor (Codex app-server, an ACP
 * agent) and the MCP servers it started are closed, even with a window
 * open -- they are most of a conversation's memory. The worker stays; the
 * next turn starts the vendor again and resumes its thread natively.
 * CLIKCODE_VENDOR_IDLE_CLOSE_MS overrides it for tests. */
const VENDOR_IDLE_CLOSE_MS = Number(process.env.CLIKCODE_VENDOR_IDLE_CLOSE_MS) > 0 ? Number(process.env.CLIKCODE_VENDOR_IDLE_CLOSE_MS) : 15 * 60 * 1000;

interface ConnectionState {
  socket: Socket;
  frames: FrameDecoder;
  attached: boolean;
  /** The attach being answered. A command sent right behind `attach` (a
   * `retire`, a `submit`) waits for it rather than being dropped as sent by
   * a window that never attached. */
  attaching?: Promise<void>;
}

/** This conversation for this worker, or undefined when another worker has
 * it. A scripted turn running in-process (worker/scripted-send.ts) is waited
 * out: its conversation comes to a worker the moment it ends. */
async function ownConversation(sessionId: string): Promise<ConversationHold | undefined> {
  for (;;) {
    const taken = await takeConversation(sessionId, 'worker');
    if ('hold' in taken) return taken.hold;
    if (taken.holder.kind === 'worker') return undefined;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

export async function runSessionWorker(sessionId: string): Promise<void> {
  const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
  const state = await readState({ transcripts: [sessionId] });
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`AI session "${sessionId}" was not found`);

  // Two windows that both found no worker each spawn one: the second to get
  // here exits, and the spawning window finds the first by its record.
  const hold = await ownConversation(sessionId);
  if (!hold) return;
  // Before any vendor process exists, so all of the agent's work is born
  // outside the window that spawned this worker (own-scope.ts).
  await separateFromForeground(sessionId);
  const socketPath = socketPathFor(sessionId);
  // A worker from a build before the hold existed takes none, and still
  // answers: it keeps the conversation. Anything else at the path is left
  // over from a worker that is gone, and binding over it is safe.
  if (await workerIsReachable(socketPath)) { await hold.release(); return; }
  await unlink(socketPath).catch(() => undefined);
  const observer = new BroadcastObserver();
  /** The last write of this worker's record: an approval's state, chained
   * so the file ends as the last state told (see onAwaitingApproval). */
  let recordWrite: Promise<void> = Promise.resolve();
  const token = generateWorkerToken();

  /** Set the moment a turn is decided on (startTurn), synchronously, and
   * cleared in runTurn's `finally`: the one guard that keeps two turns from
   * ever running at once, whoever asked for them. */
  let turnRunning = false;
  /** The queued turn the running turn is, so a second request for it -- the
   * client draining the same queue entry -- follows it instead of rerunning it. */
  let activeQueuedTurnId: string | undefined;
  let draining = false;
  /** A queued turn that failed and could not be taken out of the queue:
   * never started again, so a failing write cannot become a loop. */
  let stalledQueuedTurnId: string | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  /** The agent's in-process state for this conversation: its background
   * shells and their exit notifications (agent/session-state.ts). */
  const agentSession = sessionState(stateDirectory(), sessionId);
  const connections = new Map<Socket, ConnectionState>();
  /** The turn currently in flight, if any -- both cleared together in
   * runTurn's `finally`. A `cancel` with nothing running is simply a no-op:
   * there is nothing to abort, not an error worth reporting. */
  let activeController: AbortController | undefined;
  let activeLiveInput: LiveTurnInputBroker | undefined;
  /** Messages typed during the running turn that the worker is still placing
   * (steered, or queued durably) and answering. The turn is not over for the
   * windows until each has been: see runTurn's `finally`. */
  let activeSubmissions: Set<Promise<void>> | undefined;
  let activeRestoreDraft = false;

  // --- Vendor background turns (persistent transports) -------------------
  // Work a Codex app-server or ACP agent does between turns: broadcast,
  // persisted, and keeping this worker alive while it runs. See
  // worker/vendor-background.ts. Kept to this block, settled() before a
  // turn, saveSuperseded() and userTurnEnded() in runTurn's finally, and
  // `vendorBackground.busy` in scheduleIdleExit.
  const vendorBackground = createVendorBackgroundRunner({
    sessionId, observer, userTurnRunning: () => turnRunning, changed: () => { vendorUsed(); scheduleIdleExit(); },
  });
  setVendorBackgroundTurnHandler(sessionId, vendorBackground.handle);
  // -------------------------------------------------------------------------

  /** Why this worker cannot be replaced right now, or undefined when it can.
   * Anything it is doing for the conversation counts -- a turn, the queue
   * being drained, vendor background work, a shell or a notification the
   * model is owed -- because replacing it would lose that work. Clients do
   * not; an idle window simply attaches to the replacement next time. */
  let retireWhenIdle = false;
  /** The entry this process loaded. Re-stat'd while idle: a rebuild changes
   * mtime/size, and a worker nobody has reattached to would otherwise keep
   * the old code for its whole IDLE_EXIT_MS lifetime. */
  const spawnedBuild = currentWorkerBuild();
  const retireBlocker = (): string | undefined => {
    if (turnRunning || draining) return 'a turn is running';
    if (vendorBackground.busy) return 'vendor background work is running';
    if (hasHeldVendorProcess(sessionId)) return 'a vendor is still finishing its background work';
    if (vendorWorkSince !== undefined) return 'the vendor is still running work it started';
    if (runningShellCount(agentSession) > 0) return 'a background shell is running';
    if (agentSession.notifications.length) return 'a notification is on its way to the model';
    return undefined;
  };

  /** Idle means no client, no turn, no background shell whose exit the
   * model is still owed, and no notification on its way to it. A running
   * shell instead arms the abandoned-shell ceiling (ABANDONED_SHELL_MS). */
  /** Nobody attached, nothing running, and the entry on disk is no longer
   * what this process loaded: leave now so the next open gets a fresh
   * worker. An attached window is left alone -- its own attach asks for
   * retirement; killing under a live prompt is worse. */
  const leaveIfStaleBuild = (): void => {
    if (!spawnedBuild || observer.attachedCount > 0 || retireBlocker()) return;
    const live = currentWorkerBuild();
    if (!live || live === spawnedBuild) return;
    retireIfFree();
  };
  /** Retire for a newer build unless the vendor is running work a tool call
   * left (toolCallWork): retiring closes the vendor, which stops that work
   * and owes the model a turn to say so. Checked again at every idle edge
   * and build-watch tick, so it goes once the work has ended. */
  let retireCheck: Promise<void> | undefined;
  const retireIfFree = (): void => {
    retireCheck ??= (async () => {
      const running = await persistentWorkRunning(sessionId);
      // Something started meanwhile: its own edge checks again.
      if (retireBlocker()) return;
      if (running) { noteIdle('held: retiring once the vendor\'s work ends'); return; }
      void shutdown('replaced by a newer ClikCode build');
    })().catch(() => undefined).finally(() => { retireCheck = undefined; });
  };

  let awaitingHeldVendor = false;
  /** What the worker's idle exit is doing now, logged when it changes: what
   * holds it up, or that its timer runs (runtime/lifecycle-log.ts). */
  let idleState = '';
  const noteIdle = (state: string): void => {
    if (state === idleState) return;
    idleState = state;
    lifecycle('worker.idle', { state });
  };
  const scheduleIdleExit = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    noteIdle(turnRunning ? 'held: a turn is running' : vendorBackground.busy ? 'held: vendor background work'
      : observer.attachedCount > 0 ? `held: ${observer.attachedCount} window(s) attached` : agentSession.notifications.length ? 'held: a notification to deliver'
        : resumeWaiter.pending ? 'held: waiting for a quota reset' : hasHeldVendorProcess(sessionId) ? 'held: a vendor finishing background work'
          : runningShellCount(agentSession) > 0 ? `held: ${runningShellCount(agentSession)} background shell(s)` : `idle: exits in ${Math.round(IDLE_EXIT_MS / 1000)}s`);
    // A newer build asked for this worker while it was busy: the moment it is
    // not, it goes, and the next window to need one starts that build.
    if (retireWhenIdle && !retireBlocker()) retireIfFree();
    else leaveIfStaleBuild();
    if (turnRunning || vendorBackground.busy || observer.attachedCount > 0 || agentSession.notifications.length) return;
    // A turn parked for a quota reset: this worker is what sends it.
    if (resumeWaiter.pending) return;
    // A vendor kept running for its own background work (held-vendor.ts):
    // idling out would close it and stop that work unreported. It is
    // bounded by its own ceiling; once it is gone the idle clock starts.
    if (hasHeldVendorProcess(sessionId)) {
      if (!awaitingHeldVendor) {
        awaitingHeldVendor = true;
        void whenHeldVendorGone(sessionId).then(() => { awaitingHeldVendor = false; scheduleIdleExit(); });
      }
      return;
    }
    if (runningShellCount(agentSession) > 0) {
      const oldest = Math.min(...[...agentSession.shells.values()].filter((shell) => shell.status === 'running').map((shell) => shell.startedAt));
      idleTimer = setTimeout(stopAbandonedShells, Math.max(0, oldest + ABANDONED_SHELL_MS - Date.now()));
      idleTimer.unref();
      return;
    }
    idleTimer = setTimeout(() => { void idleReached(); }, IDLE_EXIT_MS);
    idleTimer.unref();
  };

  /** When a turn -- the user's or the vendor's own -- last ended, for the
   * vendor's idle close (VENDOR_IDLE_CLOSE_MS). */
  let vendorUsedAt = Date.now();
  let vendorIdleTimer: NodeJS.Timeout | undefined;
  const armVendorIdle = (delayMs: number): void => {
    if (vendorIdleTimer) clearTimeout(vendorIdleTimer);
    vendorIdleTimer = setTimeout(() => { vendorIdleTimer = undefined; void vendorIdleReached(); }, delayMs);
    vendorIdleTimer.unref();
  };
  const vendorUsed = (): void => {
    vendorUsedAt = Date.now();
    armVendorIdle(VENDOR_IDLE_CLOSE_MS);
  };
  const vendorIdleReached = async (): Promise<void> => {
    const work = await persistentWorkRunning(sessionId);
    // Read after the wait: a turn may have started meanwhile.
    const idleForMs = Date.now() - vendorUsedAt;
    const decision = vendorIdleDecision({
      transportOpen: hasPersistentTransport(sessionId), turnRunning: turnRunning || draining, backgroundTurn: vendorBackground.busy,
      vendorWork: work || hasHeldVendorProcess(sessionId), pendingRequests: observer.pendingRequestCount,
      idleForMs, closeAfterMs: VENDOR_IDLE_CLOSE_MS,
    });
    // A turn's end arms it again; nothing to close leaves it unarmed.
    if (decision === 'none') return;
    if (decision === 'later') { armVendorIdle(idleForMs < VENDOR_IDLE_CLOSE_MS ? VENDOR_IDLE_CLOSE_MS - idleForMs : VENDOR_WORK_RECHECK_MS); return; }
    lifecycle('vendor.idle-close', { idleMs: idleForMs, clients: observer.attachedCount });
    await closePersistentTransport(sessionId);
  };

  /** When the vendor's background work began to hold this worker up. */
  let vendorWorkSince: number | undefined;
  /** Idle time is up. A persistent vendor still running work it started (a
   * background shell under ACP, Codex items) keeps the worker -- and so the
   * vendor -- up until that work ends, then the idle clock starts again;
   * bounded like a background shell (ABANDONED_SHELL_MS). */
  const idleReached = async (): Promise<void> => {
    idleTimer = undefined;
    const running = await persistentWorkRunning(sessionId);
    // Something happened meanwhile (a turn, a window): its own edge re-arms.
    if (idleTimer || turnRunning || draining || observer.attachedCount > 0 || resumeWaiter.pending) return;
    const decision = idleDecision({ workRunning: running, workSince: vendorWorkSince, now: Date.now(), ceilingMs: ABANDONED_SHELL_MS });
    noteIdle(decision === 'recheck' ? 'held: the vendor is still running work it started' : `idle reached: ${decision}`);
    if (decision === 'recheck') {
      vendorWorkSince ??= Date.now();
      idleTimer = setTimeout(() => { void idleReached(); }, VENDOR_WORK_RECHECK_MS);
      idleTimer.unref();
      return;
    }
    vendorWorkSince = undefined;
    // Past the ceiling: shutdown tells the model the work was stopped, and why.
    if (decision === 'stop-work') { void shutdown('the work was still running 24 hours after it started, with no ClikCode window open'); return; }
    // The work just ended: a whole idle period from now, not what was left.
    if (decision === 'fresh-idle') { scheduleIdleExit(); return; }
    void shutdown('idle timeout');
  };

  /** Tell the model, through the next worker for this conversation, that
   * work its vendor left running was stopped -- never stopped unsaid. */
  const recordVendorWorkStopped = async (reason: string): Promise<void> => {
    const latest = await readState({ transcripts: [sessionId] });
    const found = latest.sessions.find((item) => item.id === sessionId);
    if (!found) return;
    const submittedAt = new Date().toISOString();
    enqueueSessionTurn(found, {
      id: randomUUID(), submittedAt, kind: 'notification',
      text: `${CLIKCODE_NOTICE_TAG}Background work you started in an earlier turn (a background command or server) was stopped: ${reason}. Check whether it finished, and start it again if it is still needed.`,
    }, submittedAt);
    await writeState(latest);
  };

  /** Stops each shell past the ceiling. Each one's exit then arrives as a
   * notification like any other, and is delivered the same way. */
  const stopAbandonedShells = (): void => {
    const cutoff = Date.now() - ABANDONED_SHELL_MS;
    for (const shell of agentSession.shells.values()) {
      if (shell.status === 'running' && shell.startedAt <= cutoff) stopBackgroundShell(shell, 'still running 24 hours after it started, with no ClikCode window open');
    }
    scheduleIdleExit();
  };

  const currentSessionAndAccount = async (): Promise<{ session: import('../session/model.js').HarnessSession; account?: string }> => {
    const latest = await readState({ transcripts: [sessionId] });
    const found = latest.sessions.find((item) => item.id === sessionId);
    if (!found) throw new Error(`AI session "${sessionId}" was not found`);
    const account = found.accountId ? latest.accounts.find((item) => item.id === found.accountId)?.label : undefined;
    return { session: found, account };
  };

  /** Ready for the route the conversation is on now -- or, off an agent
   * route, nothing left running that only an agent turn would use. */
  const prepareForRoute = async (): Promise<void> => {
    const { session: current } = await currentSessionAndAccount();
    if (!isClikCodeAgent(current)) { if (!turnRunning) await releaseMcp(); return; }
    prepareMcp(stateDirectory(), routeMcpServers(current, config));
    // Opens the connection the first step will reuse, and has the model list
    // ready for the picker.
    if (isGatewayService(current)) void gatewayModels({ config }).catch(() => undefined);
  };

  const broadcastNotice = (message: string): void => observer.broadcast({ type: 'notice', message });

  /** A turn parked until the quota resets (worker/resume-wait.ts): sent from
   * here once it has, once. `resumingTurn` marks that turn for runTurn. */
  let resumingTurn = false;
  const resumeWaiter = createResumeWaiter({
    sessionId, turnRunning: () => turnRunning || draining, notice: broadcastNotice, changed: () => scheduleIdleExit(),
    send: (prompt) => {
      resumingTurn = true;
      if (!startTurn({ type: 'submit', text: prompt, echo: prompt !== INTERRUPTED_TURN_REQUEST })) resumingTurn = false;
    },
  });

  const broadcastQueueChanged = (): void => {
    observer.broadcast({ type: 'queue-changed' });
    showEveryWindow();
  };

  /** Mid-turn, every window is showing the turn, and a message typed in one
   * of them -- steered into it or queued behind it -- belongs on all of them
   * now, not when the turn ends. The snapshot carries both (the journal's
   * steers, the queue); each window already draws them from there. */
  const showEveryWindow = (): void => {
    if (!turnRunning) return;
    void currentSessionAndAccount().then(({ session: current, account }) => observer.render(current, account)).catch(() => undefined);
  };

  /** Shell notifications become a queued turn: durable in the conversation's
   * state (a worker that stops before running it leaves it for the next
   * one), and run through the same queue as a message typed during a turn. */
  const recordNotifications = async (notes: readonly ShellNotification[]): Promise<void> => {
    if (!notes.length) return;
    const latest = await readState({ transcripts: [sessionId] });
    const found = latest.sessions.find((item) => item.id === sessionId);
    if (!found) return;
    const submittedAt = new Date().toISOString();
    enqueueSessionTurn(found, { id: randomUUID(), text: formatShellNotifications(notes), submittedAt, kind: 'notification' }, submittedAt);
    await writeState(latest);
  };

  /** A background shell finished. A running turn hands it to the model
   * before its next step (run-turn.ts) and needs nothing from here; with no
   * turn running, it is recorded and run as a follow-up turn, whether or not
   * any window is open -- an attached window follows that turn like its own. */
  const deliverNotifications = async (): Promise<void> => {
    try {
      if (!turnRunning && agentSession.notifications.length) {
        await recordNotifications(takeShellNotifications(agentSession));
        broadcastQueueChanged();
        await drainQueue();
      }
    } catch (error) {
      broadcastNotice(`Could not deliver a background shell's exit: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      scheduleIdleExit();
    }
  };
  agentSession.onNotification = () => { void deliverNotifications(); };

  /** Starts a turn unless one is already running. Synchronous from the check
   * to the flag, so nothing can slip a second turn in between. */
  const startTurn = (command: Extract<ClientCommand, { type: 'submit' }>): boolean => {
    if (turnRunning) return false;
    turnRunning = true;
    activeQueuedTurnId = command.queuedTurnId;
    void runTurn(command);
    return true;
  };

  /** Runs the queue's head when it is a notification. A message the user
   * queued is still sent by their window, which prepares what that turn
   * needs locally (a TurboFit or ClikCode Local model) before sending it; a
   * slash command only ever runs there. Anything else at the head is left,
   * and the windows are told the queue changed. */
  const reportDrainFailure = (error: unknown): void => {
    broadcastNotice(`Could not read the queue: ${error instanceof Error ? error.message : String(error)}`);
  };
  const drainQueue = async (): Promise<void> => {
    if (turnRunning || draining) return;
    draining = true;
    try {
      const { session: current } = await currentSessionAndAccount();
      const head = current.queuedTurns?.[0];
      if (!head || head.id === stalledQueuedTurnId) return;
      if (head.kind !== 'notification') { broadcastQueueChanged(); return; }
      startTurn({ type: 'submit', text: head.text, echo: true, queuedTurnId: head.id });
    } finally {
      draining = false;
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
      if (command.queuedTurnId === stalledQueuedTurnId) {
        sendEvent(socket, { type: 'turn-error', message: 'This queued message already failed and could not be taken out of the queue; remove it to continue.' });
        sendEvent(socket, { type: 'waiting-stop' });
        return;
      }
      if (turnRunning && activeQueuedTurnId === command.queuedTurnId) { follow(); return; }
      const { session: current, account } = await currentSessionAndAccount();
      if (turnRunning && activeQueuedTurnId === command.queuedTurnId) { follow(); return; }
      if (!current.queuedTurns?.some((item) => item.id === command.queuedTurnId)) {
        sendEvent(socket, { type: 'snapshot', session: current, ...(account ? { account } : {}) });
        sendEvent(socket, { type: 'waiting-stop' });
        return;
      }
    }
    // A new message from the user replaces a turn parked for the reset.
    if (!command.queuedTurnId) await resumeWaiter.cancel('Stopped waiting for the reset · a new message was sent');
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

  const runTurn = async (command: Extract<ClientCommand, { type: 'submit' }>): Promise<void> => {
    turnRunning = true;
    const turnStarted = Date.now();
    let turnOutcome = 'completed';
    lifecycle('worker.turn.start', { queued: Boolean(command.queuedTurnId), clients: observer.attachedCount });
    const resumed = resumingTurn;
    resumingTurn = false;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    const controller = new AbortController();
    const liveInput = new LiveTurnInputBroker();
    const submissions = new Set<Promise<void>>();
    activeController = controller;
    activeLiveInput = liveInput;
    activeSubmissions = submissions;
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
      await vendorBackground.settled();
      await runSessionTurn(config, sessionId, command.text, controller.signal, {
        persistentTransports: true,
        prompter: observer,
        liveInput,
        ...(command.queuedTurnId ? { queuedTurnId: command.queuedTurnId } : {}),
      });
    } catch (error) {
      const cancelled = isTurnCancelled(error);
      turnOutcome = cancelled ? 'cancelled' : `error: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`;
      if (cancelled) {
        // Same distinction interactive.ts's own catch makes today: something
        // worth keeping (text or tool activity already streamed) is
        // preserved as an interrupted turn a future turn can carry on from;
        // nothing yet is simply discarded, as if it was never sent.
        // Text or a tool row is an answer. Thinking, and a notice, are not:
        // the prompt comes back when the client asked, and the turn is not
        // kept. An answer is kept even when the client asked for the draft.
        const answered = observer.turnHasAnswer;
        if (answered) await preserveInterruptedTurn(sessionId, command.text, observer.liveResponseText, true);
        else {
          await discardInterruptedTurn(sessionId, command.text);
          if (activeRestoreDraft) observer.broadcast({ type: 'restore-draft', text: command.text });
        }
        broadcastNotice(!answered && activeRestoreDraft ? `${STOPPED} · draft restored` : STOPPED);
      } else {
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
            stalledQueuedTurnId = command.queuedTurnId;
            broadcastNotice(`A queued message failed and could not be taken out of the queue (${consumeError instanceof Error ? consumeError.message : String(consumeError)}); it will not be run again until it is removed.`);
          });
        }
      }
    } finally {
      liveInput.close();
      activeController = undefined;
      activeLiveInput = undefined;
      activeSubmissions = undefined;
      activeRestoreDraft = false;
      // A message typed as the turn ended may still be on its way into the
      // queue (the broker falls back to it once steering has closed). The
      // final snapshot, the queue drained below and its answer to the window
      // must all come after it lands: otherwise the window was told the turn
      // was over, cleared the message's row, redrew from a queue that did
      // not have it yet -- and the message vanished until the next key.
      await Promise.allSettled([...submissions]);
      // What background work this turn superseded did, now that the turn's own
      // save (which rewrites the transcript) is done.
      await vendorBackground.saveSuperseded();
      const ended = await currentSessionAndAccount();
      observer.endTurn(ended.session, ended.account);
      turnRunning = false;
      lifecycle('worker.turn.end', { outcome: turnOutcome, ms: Date.now() - turnStarted });
      vendorUsed();
      activeQueuedTurnId = undefined;
      // Vendor work that arrived while this turn was finishing.
      vendorBackground.userTurnEnded();
      // Everyone left while it ran: now nothing is using what it started.
      if (observer.attachedCount === 0) void releaseMcp();
      // Shells that finished after the turn's last step, then whatever is
      // queued next; either may start the next turn at once.
      if (agentSession.notifications.length) void deliverNotifications();
      else void drainQueue().catch(reportDrainFailure).finally(scheduleIdleExit);
      scheduleIdleExit();
      // Parked while this turn ran (another window's "Wait for reset").
      void resumeWaiter.check();
    }
  };

  const handleCommand = async (socket: Socket, command: ClientCommand, connection: ConnectionState): Promise<void> => {
    if (command.type === 'attach') {
      if (command.token !== token) {
        sendEvent(socket, { type: 'attach-rejected', reason: 'stale or invalid token' });
        socket.end();
        return;
      }
      // Read first, then join the broadcast and send the snapshot in the same
      // tick. Joined before the read, the window was sent every delta that
      // streamed during it AND a snapshot whose text already held them, and
      // drew that text twice.
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      connection.attaching = currentSessionAndAccount().then(({ session: current, account }) => {
        if (socket.destroyed) return;
        connection.attached = true;
        observer.attach(socket);
        lifecycle('worker.client.attach', { clients: observer.attachedCount, turnRunning });
        observer.snapshotFor(socket, current, account);
        // A turn waiting on an answer is asked again here: whoever it asked
        // may be gone, and this window may be the only one left to answer.
        observer.reofferPending(socket);
      });
      await connection.attaching;
      return;
    }
    if (connection.attaching) await connection.attaching.catch(() => undefined);
    if (!connection.attached) return;
    if (command.type === 'submit') {
      try { await handleSubmit(socket, command); } catch (error) {
        sendEvent(socket, { type: 'turn-error', message: error instanceof Error ? error.message : String(error) });
        sendEvent(socket, { type: 'waiting-stop' });
      }
      return;
    }
    if (command.type === 'approval-response') { observer.resolveApproval(command.id, command.approved); return; }
    if (command.type === 'sign-in-response') { observer.resolveSignIn(command.id, command.error); return; }
    if (command.type === 'refresh') {
      // What the window changed may be a turn parked for the reset.
      void resumeWaiter.check();
      const { session: current, account } = await currentSessionAndAccount();
      observer.render(current, account);
      return;
    }
    if (command.type === 'prepare') { await prepareForRoute(); return; }
    // Another window's turn may be using them: a turn keeps what it started,
    // and the turn's own end releases them if nobody is left.
    if (command.type === 'release') { if (!turnRunning) await releaseMcp(); return; }
    if (command.type === 'retire') {
      // The worker decides, not the window asking: only it knows whether it
      // is in the middle of something. A window used to decide from the
      // state file and SIGTERM it -- killing another window's turn whenever
      // the file had not caught up with the worker.
      const blocker = retireBlocker() ?? (await persistentWorkRunning(sessionId) ? 'the vendor is still running work it started' : retireBlocker());
      if (blocker) {
        retireWhenIdle = true;
        sendEvent(socket, { type: 'retire-declined', reason: blocker });
        return;
      }
      void shutdown('replaced by a newer ClikCode build');
      return;
    }
    if (command.type === 'detach') { socket.end(); return; }
    if (command.type === 'unqueue') {
      // Always answered: the window waits on this to know whether it may stop
      // the running turn for its "send now".
      const answer = (outcome: 'removed' | 'running' | 'gone' | 'error', message?: string): void => {
        sendEvent(socket, { type: 'unqueued', id: command.id, outcome, ...(message ? { message } : {}) });
      };
      if (activeQueuedTurnId === command.id) { answer('running'); return; }
      // One the running turn is holding to steer in must not be sent now;
      // one already on its way into the turn is not the queue's any more.
      if (activeLiveInput?.withdraw(command.id) === false) { answer('running'); return; }
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
    }
    if (command.type === 'send-queued') {
      // Enter again. The oldest message the user queued goes into this turn
      // at the next pause. The turn is not cancelled, so a sub-agent it
      // started keeps running. A command or a notice stays for the turn's end.
      const answer = (disposition: 'steered' | 'queued' | 'error', id?: string, message?: string, unsteered?: boolean): void => {
        if (id) sendEvent(socket, { type: 'submission', id, disposition, ...(message ? { message } : {}), ...(unsteered ? { unsteered } : {}) });
      };
      if (!activeLiveInput) return;
      const liveInput = activeLiveInput;
      let item: { id: string; text: string } | undefined;
      try {
        const state = await readState({ transcripts: [sessionId] });
        const session = state.sessions.find((entry) => entry.id === sessionId);
        const queued = session?.queuedTurns?.find((entry) => entry.kind !== 'command' && entry.kind !== 'notification');
        if (!session || !queued) return;
        if (liveInput.holding(queued.id)) {
          answer('queued', queued.id);
          return;
        }
        if (!consumeSessionTurn(session, queued.id)) return;
        await writeState(state);
        item = { id: queued.id, text: queued.text };
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
          answer(result.disposition === 'steered' ? 'steered' : 'queued', queuedItem.id, undefined, result.unsteered);
          if (result.disposition !== 'steered') broadcastQueueChanged();
          else showEveryWindow();
          void result.landed?.then((steered) => { if (steered) broadcastQueueChanged(); });
        } catch (error) {
          answer('error', queuedItem.id, error instanceof Error ? error.message : String(error));
        }
      })();
      activeSubmissions?.add(handled);
      await handled;
      return;
    }
    if (command.type === 'cancel') {
      // Nothing running is not an error -- a cancel racing the turn's own
      // natural completion is ordinary, not a client mistake to report.
      // With none, it cancels a turn parked for the reset, if there is one.
      if (!activeController) { await resumeWaiter.cancel('Stopped waiting for the reset'); return; }
      activeRestoreDraft = command.restoreDraft;
      activeController.abort();
      return;
    }
    if (command.type === 'steer') {
      const answer = (disposition: 'steered' | 'queued' | 'error', message?: string, unsteered?: boolean): void => {
        if (command.id) sendEvent(socket, { type: 'submission', id: command.id, disposition, ...(message ? { message } : {}), ...(unsteered ? { unsteered } : {}) });
      };
      // The turn ended between the client's Enter and this arriving. This used
      // to `return` -- and the message was simply gone. Nothing is running to
      // steer into, so it is queued durably and the interactive loop sends it
      // as the next turn, exactly as a queued message always is.
      if (!activeLiveInput) {
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
      const liveInput = activeLiveInput;
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
          if (!command.id) broadcastNotice(`Could not send: ${message}`);
        }
      })();
      activeSubmissions?.add(handled);
      await handled;
      return;
    }
  };

  const server = createServer((socket) => {
    const connection: ConnectionState = { socket, frames: new FrameDecoder(), attached: false };
    connections.set(socket, connection);
    socket.on('data', (chunk) => {
      for (const message of connection.frames.push(chunk)) void handleCommand(socket, message as ClientCommand, connection);
    });
    socket.on('close', () => {
      connections.delete(socket);
      const wasAttached = connection.attached;
      observer.detach(socket);
      if (wasAttached) lifecycle('worker.client.detach', { clients: observer.attachedCount, turnRunning });
      // The conversation is closed on every terminal that had it: nothing
      // local stays running for it. A running turn keeps what it is using;
      // the next turn starts servers again if it needs them.
      if (observer.attachedCount === 0 && !turnRunning) void releaseMcp();
      scheduleIdleExit();
    });
    socket.on('error', () => socket.destroy());
  });

  /** Once: a second signal while the first shutdown is still recording
   * what it stopped must not exit underneath that write. */
  let shuttingDown: Promise<void> | undefined;
  const shutdown = (reason: string): Promise<void> => {
    // Every step below is bounded (a vendor gets seconds, then is killed; a
    // state write gives up after its lock wait). A step that throws must
    // still end in an exit: a rejected shutdown never reached it.
    shuttingDown ??= shutdownOnce(reason).catch(() => process.exit(0));
    return shuttingDown;
  };
  const shutdownOnce = async (reason: string): Promise<void> => {
    lifecycle('worker.shutdown', { reason, turnRunning, clients: observer.attachedCount });
    // Background shells the agent tools started are spawned DETACHED on
    // everything but Windows, so they outlive this process rather than dying
    // with it. disposeSessionState is the only thing that kills them and had
    // no caller anywhere, which meant a background command survived its
    // worker, its session and this terminal -- indefinitely. Done on every
    // shutdown reason, not just the idle one: whenever this worker is going
    // away, so is the session whose shells these are.
    //
    // What the model was never told -- notifications not yet delivered, and
    // each shell this stops -- is recorded as a queued turn first, so the
    // next worker for the conversation delivers it.
    const undelivered = disposeSessionState(stateDirectory(), sessionId, `ClikCode's worker for this conversation stopped (${reason})`);
    let owed = undelivered.length > 0;
    await recordNotifications(undelivered).catch(() => undefined);
    // The same for work a persistent vendor left running: closing the child
    // below stops it.
    if (await persistentWorkRunning(sessionId)) {
      owed = true;
      await recordVendorWorkStopped(`ClikCode's worker for this conversation stopped (${reason})`).catch(() => undefined);
    }
    // Codex app-server and ACP children are spawned detached too, and were
    // orphaned the same way.
    await closePersistentTransport().catch(() => undefined);
    for (const connection of connections.keys()) {
      sendEvent(connection, { type: 'shutdown', reason });
      connection.end();
    }
    server.close();
    // Only what is still this worker's: the record and socket of a worker
    // that replaced it are that worker's to remove.
    observer.onAwaitingApproval = undefined;
    await recordWrite;
    await removeWorkerRecord(sessionId, token).catch(() => undefined);
    if (await hold.held()) await unlink(socketPath).catch(() => undefined);
    await hold.release().catch(() => undefined);
    // Owed the model something and stopped by nobody's choice (a newer
    // build, the 24-hour ceiling): a successor -- on whatever build is
    // installed now -- delivers it at once, instead of waiting for someone
    // to reopen the conversation. Stopped by a signal, it stays stopped.
    // A turn parked for the reset is owed too: the successor sends it.
    resumeWaiter.stop();
    const successor = startsSuccessor(owed || resumeWaiter.pending, reason);
    lifecycle('worker.stopped', { reason, owed, successor });
    if (successor) startSuccessor();
    process.exit(0);
  };
  const startSuccessor = (): void => {
    try {
      const child = spawn(process.execPath, [process.argv[1]!, 'session-worker', sessionId], { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => undefined);
      child.unref();
    } catch { /* fail-open-ok: the queued notification waits for the next open */ }
  };

  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      server.once('error', rejectListening);
      server.listen(socketPath, resolveListening);
    });
  } catch (error) {
    await hold.release();
    throw error;
  }
  const record = {
    pid: process.pid, sessionId, socketPath, installationId: state.installationId, startedAt: new Date().toISOString(), token,
    ...(currentWorkerBuild() ? { build: currentWorkerBuild() } : {}),
  };
  await writeWorkerRecord(record);
  observer.onAwaitingApproval = (awaitingApproval) => {
    recordWrite = recordWrite
      .then(() => writeWorkerRecord({ ...record, ...(awaitingApproval ? { awaitingApproval } : {}) }, { existing: true }))
      .catch(() => undefined);
    return recordWrite;
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  scheduleIdleExit();
  // A rebuild while this worker sits idle with nobody attached: scheduleIdleExit
  // only runs on attach/detach/turn edges otherwise, so without this a stale
  // worker would wait out the full idle timeout before noticing. This checks
  // the build only: re-arming the idle timer here would restart it every
  // tick, and it would never fire.
  const buildWatch = setInterval(() => {
    // A home that is gone (a test run's, cleaned up) has no conversation to
    // serve or save: whatever this worker was waiting on, it leaves. Two
    // workers lived for days this way, each holding its MCP servers.
    if (!existsSync(stateDirectory())) { void shutdown('its ClikCode home was removed'); return; }
    leaveIfStaleBuild();
  }, BUILD_WATCH_MS);
  buildWatch.unref();
  // A notification a previous worker recorded but never ran.
  void drainQueue().catch(reportDrainFailure);
  // A turn parked for the reset by a window, or left by a worker before this.
  void resumeWaiter.check();
}

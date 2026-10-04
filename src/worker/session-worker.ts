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
import { createServer, type Socket } from 'node:net';
import { hasHeldVendorProcess, whenHeldVendorGone } from '../harness/transport/native/held-vendor.js';
import { unlink } from 'node:fs/promises';
import Conf from 'conf';
import { runSessionTurn } from '../turn/session-turn.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { consumeSessionTurn, enqueueSessionTurn } from '../turn/checkpoint.js';
import { consumeQueuedTurn } from './consume-queued.js';
import { randomUUID } from 'node:crypto';
import { LiveTurnInputBroker } from '../turn/live-input.js';
import { closePersistentTransport, setVendorBackgroundTurnHandler } from '../turn/vendor-process.js';
import { discardInterruptedTurn, preserveInterruptedTurn } from '../turn/turn-journal.js';
import { BroadcastObserver, sendEvent } from './broadcast-observer.js';
import { createVendorBackgroundRunner } from './vendor-background.js';
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
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`AI session "${sessionId}" was not found`);

  // Two windows that both found no worker each spawn one: the second to get
  // here exits, and the spawning window finds the first by its record.
  const hold = await ownConversation(sessionId);
  if (!hold) return;
  const socketPath = socketPathFor(sessionId);
  // A worker from a build before the hold existed takes none, and still
  // answers: it keeps the conversation. Anything else at the path is left
  // over from a worker that is gone, and binding over it is safe.
  if (await workerIsReachable(socketPath)) { await hold.release(); return; }
  await unlink(socketPath).catch(() => undefined);
  const observer = new BroadcastObserver();
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
    sessionId, observer, userTurnRunning: () => turnRunning, changed: () => scheduleIdleExit(),
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
  const leaveIfStaleBuild = (): boolean => {
    if (!spawnedBuild || observer.attachedCount > 0 || retireBlocker()) return false;
    const live = currentWorkerBuild();
    if (!live || live === spawnedBuild) return false;
    void shutdown('replaced by a newer ClikCode build');
    return true;
  };

  let awaitingHeldVendor = false;
  const scheduleIdleExit = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    // A newer build asked for this worker while it was busy: the moment it is
    // not, it goes, and the next window to need one starts that build.
    if (retireWhenIdle && !retireBlocker()) { void shutdown('replaced by a newer ClikCode build'); return; }
    if (leaveIfStaleBuild()) return;
    if (turnRunning || vendorBackground.busy || observer.attachedCount > 0 || agentSession.notifications.length) return;
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
    idleTimer = setTimeout(() => { void shutdown('idle timeout'); }, IDLE_EXIT_MS);
    idleTimer.unref();
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
    const latest = await readState();
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
    const latest = await readState();
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
    if (startTurn(command)) return;
    let queuedTurnId = command.queuedTurnId;
    if (!queuedTurnId) {
      queuedTurnId = randomUUID();
      const latest = await readState();
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
      const cancelled = (error as NodeJS.ErrnoException).code === 'ERR_TURN_CANCELLED' || (error as Error).name === 'AbortError';
      if (cancelled) {
        // Same distinction interactive.ts's own catch makes today: something
        // worth keeping (text or tool activity already streamed) is
        // preserved as an interrupted turn a future turn can carry on from;
        // nothing yet is simply discarded, as if it was never sent.
        const outputStarted = observer.turnOutputStarted;
        if (outputStarted) await preserveInterruptedTurn(sessionId, command.text, observer.liveResponseText, true);
        else {
          await discardInterruptedTurn(sessionId, command.text);
          if (activeRestoreDraft) observer.broadcast({ type: 'restore-draft', text: command.text });
        }
        broadcastNotice(outputStarted ? 'Stopped' : activeRestoreDraft ? 'Stopped · draft restored' : 'Stopped');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        observer.broadcast({ type: 'turn-error', message });
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
      const blocker = retireBlocker();
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
      try {
        const state = await readState();
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
    if (command.type === 'cancel') {
      // Nothing running is not an error -- a cancel racing the turn's own
      // natural completion is ordinary, not a client mistake to report.
      if (!activeController) return;
      activeRestoreDraft = command.restoreDraft;
      activeController.abort();
      return;
    }
    if (command.type === 'steer') {
      const answer = (disposition: 'steered' | 'queued' | 'error', message?: string): void => {
        if (command.id) sendEvent(socket, { type: 'submission', id: command.id, disposition, ...(message ? { message } : {}) });
      };
      // The turn ended between the client's Enter and this arriving. This used
      // to `return` -- and the message was simply gone. Nothing is running to
      // steer into, so it is queued durably and the interactive loop sends it
      // as the next turn, exactly as a queued message always is.
      if (!activeLiveInput) {
        try {
          const state = await readState();
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
          const result = await liveInput.submit(command.text, command.id);
          answer(result.disposition === 'steered' ? 'steered' : 'queued');
          // Every window shows the queue, not only the one that typed it.
          if (result.disposition !== 'steered') broadcastQueueChanged();
          else showEveryWindow();
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
      observer.detach(socket);
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
  const shutdown = (reason: string): Promise<void> => (shuttingDown ??= shutdownOnce(reason));
  const shutdownOnce = async (reason: string): Promise<void> => {
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
    await recordNotifications(undelivered).catch(() => undefined);
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
    await removeWorkerRecord(sessionId, token).catch(() => undefined);
    if (await hold.held()) await unlink(socketPath).catch(() => undefined);
    await hold.release().catch(() => undefined);
    process.exit(0);
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
  await writeWorkerRecord({
    pid: process.pid, sessionId, socketPath, installationId: state.installationId, startedAt: new Date().toISOString(), token,
    ...(currentWorkerBuild() ? { build: currentWorkerBuild() } : {}),
  });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  scheduleIdleExit();
  // A rebuild while this worker sits idle with nobody attached: scheduleIdleExit
  // only runs on attach/detach/turn edges otherwise, so without this a stale
  // worker would wait out the full idle timeout before noticing. This checks
  // the build only: re-arming the idle timer here would restart it every
  // tick, and it would never fire.
  const buildWatch = setInterval(() => { leaveIfStaleBuild(); }, BUILD_WATCH_MS);
  buildWatch.unref();
  // A notification a previous worker recorded but never ran.
  void drainQueue().catch(reportDrainFailure);
}

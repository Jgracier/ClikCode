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
import { unlink } from 'node:fs/promises';
import Conf from 'conf';
import { aiGatewaySessionSend } from '../turn/drive.js';
import { readState } from '../session/state/read.js';
import { LiveTurnInputBroker } from '../turn/live-input.js';
import { discardInterruptedTurn, preserveInterruptedTurn } from '../turn/runtime.js';
import { BroadcastObserver } from './broadcast-observer.js';
import { decodeFrames, encodeFrame, type ClientCommand } from './protocol.js';
import { ensureWorkersDirectory, generateWorkerToken, removeWorkerRecord, socketPathFor, writeWorkerRecord } from './registry.js';

/** No attached client and no turn running, for this long: the worker exits
 * on its own rather than living forever the way the process it replaces
 * did. Generous enough that a flaky reconnect (the original SIGHUP/SIGINT
 * problem this whole design fixes more robustly) has plenty of time to
 * happen without racing a shutdown; short enough that a genuinely abandoned
 * session does not sit as dead weight for days the way the zombie processes
 * that motivated this design did. */
const IDLE_EXIT_MS = 30 * 60 * 1000;

interface ConnectionState {
  socket: Socket;
  buffer: string;
  attached: boolean;
}

export async function runSessionWorker(sessionId: string): Promise<void> {
  const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`AI session "${sessionId}" was not found`);

  const observer = new BroadcastObserver();
  const socketPath = socketPathFor(sessionId);
  const token = generateWorkerToken();
  await ensureWorkersDirectory();
  await unlink(socketPath).catch(() => undefined);

  let turnRunning = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const connections = new Map<Socket, ConnectionState>();
  /** The turn currently in flight, if any -- both cleared together in
   * runTurn's `finally`. A `cancel` with nothing running is simply a no-op:
   * there is nothing to abort, not an error worth reporting. */
  let activeController: AbortController | undefined;
  let activeLiveInput: LiveTurnInputBroker | undefined;
  let activeRestoreDraft = false;

  const scheduleIdleExit = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (turnRunning || observer.attachedCount > 0) return;
    idleTimer = setTimeout(() => { void shutdown('idle timeout'); }, IDLE_EXIT_MS);
    idleTimer.unref();
  };

  const currentSessionAndAccount = async (): Promise<{ session: import('../session/model.js').HarnessSession; account?: string }> => {
    const latest = await readState();
    const found = latest.sessions.find((item) => item.id === sessionId);
    if (!found) throw new Error(`AI session "${sessionId}" was not found`);
    const account = found.accountId ? latest.accounts.find((item) => item.id === found.accountId)?.label : undefined;
    return { session: found, account };
  };

  const broadcastNotice = (message: string): void => {
    for (const connection of connections.keys()) connection.write(encodeFrame({ type: 'notice', message }));
  };

  const runTurn = async (command: Extract<ClientCommand, { type: 'submit' }>): Promise<void> => {
    turnRunning = true;
    if (idleTimer) clearTimeout(idleTimer);
    const controller = new AbortController();
    const liveInput = new LiveTurnInputBroker();
    activeController = controller;
    activeLiveInput = liveInput;
    // startWaiting/stopWaiting bracket the call the same way interactive.ts's
    // own runInteractiveTurn does today -- drive.ts itself never calls
    // either, by design (see turn/observer.ts): they are the ORCHESTRATOR
    // signalling "a turn is in flight", not something a turn declares about
    // itself. In the worker model the worker is that orchestrator now, and
    // stopWaiting is the one event every client needs regardless of outcome
    // to know a `submit` it sent has actually finished -- broadcast in
    // `finally`, covering success, a caught failure, and cancellation alike.
    observer.startWaiting('thinking');
    try {
      await aiGatewaySessionSend(config, sessionId, command.text, controller.signal, {
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
          if (activeRestoreDraft) {
            for (const connection of connections.keys()) connection.write(encodeFrame({ type: 'restore-draft', text: command.text }));
          }
        }
        broadcastNotice(outputStarted ? 'Stopped' : activeRestoreDraft ? 'Stopped · draft restored' : 'Stopped');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        for (const connection of connections.keys()) connection.write(encodeFrame({ type: 'turn-error', message }));
      }
    } finally {
      liveInput.close();
      activeController = undefined;
      activeLiveInput = undefined;
      activeRestoreDraft = false;
      observer.stopWaiting();
      observer.render((await currentSessionAndAccount()).session);
      turnRunning = false;
      scheduleIdleExit();
    }
  };

  const handleCommand = async (socket: Socket, command: ClientCommand, connection: ConnectionState): Promise<void> => {
    if (command.type === 'attach') {
      if (command.token !== token) {
        socket.write(encodeFrame({ type: 'attach-rejected', reason: 'stale or invalid token' }));
        socket.end();
        return;
      }
      connection.attached = true;
      observer.attach(socket);
      if (idleTimer) clearTimeout(idleTimer);
      const { session: current, account } = await currentSessionAndAccount();
      const live = observer.liveSnapshot();
      socket.write(encodeFrame({ type: 'snapshot', session: current, ...(account ? { account } : {}), ...(live ? { live } : {}) }));
      return;
    }
    if (!connection.attached) return;
    if (command.type === 'submit') { void runTurn(command); return; }
    if (command.type === 'approval-response') { observer.resolveApproval(command.id, command.approved); return; }
    if (command.type === 'refresh') { observer.render((await currentSessionAndAccount()).session); return; }
    if (command.type === 'detach') { socket.end(); return; }
    if (command.type === 'cancel') {
      // Nothing running is not an error -- a cancel racing the turn's own
      // natural completion is ordinary, not a client mistake to report.
      if (!activeController) return;
      activeRestoreDraft = command.restoreDraft;
      activeController.abort();
      return;
    }
    if (command.type === 'steer') {
      if (!activeLiveInput) return;
      // Best-effort: a steer that fails (the turn finished between the
      // client sending it and this running) has nothing left to steer into
      // -- the broker's own submit() already falls back to the durable
      // queue for the more common races; only report what neither of those
      // paths can recover from.
      try { await activeLiveInput.submit(command.text); } catch (error) {
        broadcastNotice(`Could not send: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
  };

  const server = createServer((socket) => {
    const connection: ConnectionState = { socket, buffer: '', attached: false };
    connections.set(socket, connection);
    socket.on('data', (chunk) => {
      const { messages, rest } = decodeFrames(connection.buffer + chunk.toString('utf8'));
      connection.buffer = rest;
      for (const message of messages) void handleCommand(socket, message as ClientCommand, connection);
    });
    socket.on('close', () => {
      connections.delete(socket);
      observer.detach(socket);
      scheduleIdleExit();
    });
    socket.on('error', () => socket.destroy());
  });

  const shutdown = async (reason: string): Promise<void> => {
    for (const connection of connections.keys()) {
      connection.write(encodeFrame({ type: 'shutdown', reason }));
      connection.end();
    }
    server.close();
    await removeWorkerRecord(sessionId).catch(() => undefined);
    await unlink(socketPath).catch(() => undefined);
    process.exit(0);
  };

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(socketPath, resolveListening);
  });
  await writeWorkerRecord({
    pid: process.pid, sessionId, socketPath, installationId: state.installationId, startedAt: new Date().toISOString(), token,
  });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  scheduleIdleExit();
}

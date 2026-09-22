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

  const runTurn = async (command: Extract<ClientCommand, { type: 'submit' }>): Promise<void> => {
    turnRunning = true;
    if (idleTimer) clearTimeout(idleTimer);
    try {
      await aiGatewaySessionSend(config, sessionId, command.text, undefined, {
        persistentTransports: true,
        prompter: observer,
        ...(command.queuedTurnId ? { queuedTurnId: command.queuedTurnId } : {}),
      });
    } catch (error) {
      observer.render((await currentSessionAndAccount()).session);
      const message = error instanceof Error ? error.message : String(error);
      for (const connection of connections.keys()) connection.write(encodeFrame({ type: 'turn-error', message }));
    } finally {
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
    // 'steer' and 'cancel' need the live-input/abort-signal plumbing
    // turn/live-input.ts already provides to the interactive client today;
    // wiring that through is the remaining work before this worker can
    // actually replace commands/ai/interactive.ts's own turn loop, not
    // something this pass pretends to have solved.
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

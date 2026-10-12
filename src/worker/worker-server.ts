/** The worker's socket server: one connection per window, frames decoded into commands. */
import { createServer } from 'node:net';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { releaseMcp } from '../agent/mcp/manager.js';
import { FrameDecoder, type ClientCommand } from './protocol.js';
import type { ConnectionState, WorkerContext } from './worker-context.js';

export function createWorkerServer(ctx: WorkerContext, handleCommand: (socket: ConnectionState['socket'], command: ClientCommand, connection: ConnectionState) => Promise<void>) {
  const { observer, connections } = ctx;
  return createServer((socket) => {
    const connection: ConnectionState = { socket, frames: new FrameDecoder(), attached: false };
    connections.set(socket, connection);
    socket.on('data', (chunk) => {
      for (const message of connection.frames.push(chunk)) void handleCommand(socket, message as ClientCommand, connection);
    });
    socket.on('close', () => {
      connections.delete(socket);
      const wasAttached = connection.attached;
      observer.detach(socket);
      if (wasAttached) lifecycle('worker.client.detach', { clients: observer.attachedCount, turnRunning: ctx.turnRunning });
      // The conversation is closed on every terminal that had it: nothing
      // local stays running for it. A running turn keeps what it is using;
      // the next turn starts servers again if it needs them.
      if (observer.attachedCount === 0 && !ctx.turnRunning) void releaseMcp();
      ctx.idle.scheduleIdleExit();
    });
    socket.on('error', () => socket.destroy());
  });
}

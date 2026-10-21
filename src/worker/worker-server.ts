/** The worker's socket server: one connection per window, frames decoded into commands. */
import { createServer } from 'node:net';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { releaseMcp } from '../agent/mcp/manager.js';
import { sendEvent } from './broadcast-observer.js';
import { FrameDecoder, type ClientCommand } from './protocol.js';
import type { ConnectionState, WorkerContext } from './worker-context.js';

export function createWorkerServer(ctx: WorkerContext, handleCommand: (socket: ConnectionState['socket'], command: ClientCommand, connection: ConnectionState) => Promise<void>) {
  const { observer, connections } = ctx;
  return createServer((socket) => {
    const connection: ConnectionState = { socket, frames: new FrameDecoder(), attached: false };
    connections.set(socket, connection);
    socket.on('data', (chunk) => {
      for (const message of connection.frames.push(chunk)) {
        // A command that throws must not become an unhandled rejection (which ends the process, and
        // every turn in it): the window is told, and goes on.
        void handleCommand(socket, message as ClientCommand, connection).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          lifecycle('worker.command.failed', { type: (message as { type?: unknown }).type, message: reason });
          sendEvent(socket, { type: 'note', message: `The conversation's worker could not do that: ${reason}` });
        });
      }
    });
    socket.on('close', () => {
      connections.delete(socket);
      const wasAttached = connection.attached;
      observer.detach(socket);
      if (wasAttached) lifecycle('worker.client.detach', { clients: observer.attachedCount, turnRunning: ctx.turnRunning });
      // The conversation is closed on every terminal that had it: nothing
      // local stays running for it. A running turn keeps what it is using;
      // the next turn starts servers again if it needs them.
      // A connection that never attached (a question on its own: retire, warm)
      // closed no conversation.
      if (wasAttached && observer.attachedCount === 0 && !ctx.turnRunning) void releaseMcp();
      ctx.idle.scheduleIdleExit();
    });
    socket.on('error', () => socket.destroy());
  });
}

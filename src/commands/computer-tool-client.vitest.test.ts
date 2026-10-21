/** The computer tools' one connection to the chat's worker: every call shares it, a lost one is
 * opened again on the next call, and a worker from before calls without an attach is asked the old
 * way. The worker is a socket server speaking the frame protocol. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame, FrameDecoder, type ClientCommand } from '../worker/protocol.js';

const fake = vi.hoisted(() => ({ socketPath: '', attach: vi.fn() }));
vi.mock('../worker/client.js', () => ({
  workerForCommands: async (sessionId: string) => ({ sessionId, pid: 4242, token: 'tok', socketPath: fake.socketPath }),
  WorkerClient: { attach: fake.attach },
}));
vi.mock('./ai/harness.js', () => ({ resolveChat: async (chat: string) => chat }));

const { callWorkerTool, closeToolLines } = await import('./computer-tool-client.js');

let dir: string;
let server: Server;
let connections: Socket[];
let received: ClientCommand[];

/** A worker; `answers` false is one from before calls without an attach (it ignores them). */
function worker(answers: boolean): Promise<void> {
  connections = [];
  received = [];
  server = createServer((socket) => {
    connections.push(socket);
    const frames = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const message of frames.push(chunk)) {
        const command = message as ClientCommand;
        received.push(command);
        if (!answers || command.type !== 'computer-tool' || command.token !== 'tok') continue;
        socket.write(encodeFrame({ type: 'computer-tool-started', id: command.id }));
        socket.write(encodeFrame({ type: 'computer-tool-result', id: command.id, ok: true, output: `did ${command.tool}` }));
      }
    });
  });
  return new Promise((resolve) => server.listen(fake.socketPath, () => resolve()));
}

const call = (tool: string) => callWorkerTool({ chat: 'chat-1', tool, args: {} });

describe('the computer tools\' connection to the worker', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tool-line-'));
    fake.socketPath = join(dir, 'worker.sock');
    delete process.env.CLIKCODE_WORKER_PID;
  });
  afterEach(async () => {
    closeToolLines();
    fake.attach.mockReset();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves every call over one connection, without attaching', async () => {
    await worker(true);
    expect(await Promise.all([call('a'), call('b')])).toEqual([{ ok: true, output: 'did a' }, { ok: true, output: 'did b' }]);
    expect(await call('c')).toEqual({ ok: true, output: 'did c' });
    expect(connections).toHaveLength(1);
    expect(received.map((command) => command.type)).toEqual(['computer-tool', 'computer-tool', 'computer-tool']);
    expect(fake.attach).not.toHaveBeenCalled();
  });

  it('opens the connection again on the next call once it is lost', async () => {
    await worker(true);
    await call('a');
    connections[0]!.destroy();
    await vi.waitFor(() => expect(connections[0]!.destroyed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await call('b')).toEqual({ ok: true, output: 'did b' });
    expect(connections).toHaveLength(2);
  });

  it('asks a worker that ignores a call without an attach the old way, and keeps doing so', async () => {
    await worker(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fake.attach.mockImplementation(async () => {
        const client = Object.assign(new EventEmitter(), {
          send: (command: ClientCommand) => {
            if (command.type !== 'computer-tool') return;
            queueMicrotask(() => client.emit('event', { type: 'computer-tool-result', id: command.id, ok: true, output: `attached ${command.tool}` }));
          },
          close: vi.fn(),
        });
        return client;
      });
      const first = call('a');
      await vi.waitFor(() => expect(received).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await first).toEqual({ ok: true, output: 'attached a' });
      expect(await call('b')).toEqual({ ok: true, output: 'attached b' });
      // The second went straight to the old way: the line was not asked again.
      expect(received).toHaveLength(1);
      expect(fake.attach).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

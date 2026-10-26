/** What a window does when it attaches to a worker, against stand-in workers
 * on real sockets: a connection that ends, a question about retiring that is
 * not answered, and a slim snapshot whose messages are read from disk. The
 * real worker is exercised in session-worker.vitest.test.ts. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import { WorkerClient, warmSessionWorker } from './client.js';
import { currentWorkerBuild, ensureWorkersDirectory, socketPathFor, writeWorkerRecord } from './registry.js';
import { encodeFrame, FrameDecoder, type ClientCommand, type WorkerEvent } from './protocol.js';

const previousHome = process.env.CLIKCODE_HOME;
let root: string;
const servers: Server[] = [];
const clients: WorkerClient[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clikcode-attach-'));
  process.env.CLIKCODE_HOME = root;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); })));
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

const TOKEN = 'stand-in-token';
type Seen = Array<{ connection: number; command: ClientCommand }>;

/** A worker that is a listening socket and a record, answering as `handle` says. */
async function standInWorker(
  sessionId: string,
  handle: (socket: Socket, command: ClientCommand, connection: number) => void,
  build: string | undefined = currentWorkerBuild(),
): Promise<{ seen: Seen; connections: () => number }> {
  await ensureWorkersDirectory();
  const seen: Seen = [];
  let connections = 0;
  const server = createServer((socket) => {
    // Numbered by the order they first speak: a liveness probe connects and
    // closes without a word, and is not a conversation with the worker.
    let connection = 0;
    const frames = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const message of frames.push(chunk)) {
        if (!connection) connection = (connections += 1);
        seen.push({ connection, command: message as ClientCommand });
        handle(socket, message as ClientCommand, connection);
      }
    });
    socket.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPathFor(sessionId), resolve));
  await writeWorkerRecord({
    pid: process.pid, sessionId, socketPath: socketPathFor(sessionId), installationId: 'stand-in',
    startedAt: new Date().toISOString(), token: TOKEN, ...(build ? { build } : {}),
  });
  return { seen, connections: () => connections };
}

const snapshot = (sessionId: string, extra: Partial<Extract<WorkerEvent, { type: 'snapshot' }>> = {}): string =>
  encodeFrame({ type: 'snapshot', session: { id: sessionId } as HarnessSession, ...extra });

/** A conversation saved with `count` messages. */
async function savedConversation(count: number): Promise<string> {
  const state = await readState();
  const now = new Date().toISOString();
  const id = randomUUID();
  state.sessions.push({
    id, conversationId: id, route: 'local', accountId: null, provider: null, model: null, effort: 'medium',
    permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
    messages: Array.from({ length: count }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: `message ${index}` })),
  } as HarnessSession);
  await writeState(state);
  return id;
}

describe('an attach whose connection ends before the worker answers', () => {
  it('fails at once, after one more try, instead of waiting out the answer timer', async () => {
    const id = randomUUID();
    const worker = await standInWorker(id, (socket) => socket.destroy());
    const started = Date.now();
    await expect(WorkerClient.attachExisting(id)).rejects.toThrow(/before it answered/);
    // The timer for a worker that says nothing is 30 s.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(worker.connections()).toBe(2);
  });

  it('reconnects once when the first connection was lost, and the attach succeeds', async () => {
    const id = randomUUID();
    const worker = await standInWorker(id, (socket, command, connection) => {
      if (command.type !== 'attach') return;
      if (connection === 1) socket.destroy(); else socket.write(snapshot(id));
    });
    const client = (await WorkerClient.attachExisting(id))!;
    clients.push(client);
    expect((await client.initialSnapshot).type).toBe('snapshot');
    expect(worker.connections()).toBe(2);
  });
});

describe('warming an open conversation', () => {
  it('coalesces simultaneous warm requests into one worker command', async () => {
    const id = randomUUID();
    const worker = await standInWorker(id, () => undefined);
    await Promise.all([warmSessionWorker(id), warmSessionWorker(id)]);
    await vi.waitFor(() => expect(worker.seen.filter((entry) => entry.command.type === 'warm')).toHaveLength(1));
  });
});

describe('asking a worker on another build to retire', () => {
  it('is a question on its own: the token and nothing else, so no snapshot is sent for nothing', async () => {
    const id = randomUUID();
    const worker = await standInWorker(id, (socket, command) => {
      if (command.type === 'retire') socket.write(encodeFrame({ type: 'retire-declined', reason: 'a turn is running' }));
      if (command.type === 'attach') socket.write(snapshot(id));
    }, 'a-different-build');
    const client = (await WorkerClient.attachExisting(id))!;
    clients.push(client);
    await client.initialSnapshot;
    const first = worker.seen.filter((entry) => entry.connection === 1).map((entry) => entry.command);
    expect(first).toEqual([{ type: 'retire', token: TOKEN }]);
  });

  it('does not wait for a worker that is still there when the connection ends with no answer', async () => {
    const id = randomUUID();
    // The very thing a busy worker did to the question when it carried a whole conversation.
    const worker = await standInWorker(id, (socket, command) => {
      if (command.type === 'retire') socket.destroy();
      if (command.type === 'attach') socket.write(snapshot(id));
    }, 'a-different-build');
    const started = Date.now();
    const client = (await WorkerClient.attachExisting(id))!;
    clients.push(client);
    await client.initialSnapshot;
    // Read as "retired" it waited out RETIRE_TIMEOUT_MS (3 s) for a socket that never went.
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(worker.connections()).toBe(2);
  });

  it('keeps a worker that never answers the question, after the time it is given', async () => {
    const id = randomUUID();
    await standInWorker(id, (socket, command) => { if (command.type === 'attach') socket.write(snapshot(id)); }, 'a-different-build');
    const client = (await WorkerClient.attachExisting(id))!;
    clients.push(client);
    expect((await client.initialSnapshot).type).toBe('snapshot');
  });
});

describe('a snapshot that leaves the saved messages out', () => {
  it('is completed from the saved conversation, to the count the worker saw, before what follows it', async () => {
    const sessionId = await savedConversation(3);
    // The transcript has moved on (3) since the worker looked (2): the window draws what the snapshot describes.
    await standInWorker(sessionId, (socket, command) => {
      if (command.type !== 'attach') return;
      socket.write(snapshot(sessionId, { saved: { count: 2 } }) + encodeFrame({ type: 'delta', text: 'next', mode: 'append' }));
    });
    const client = (await WorkerClient.attachExisting(sessionId))!;
    clients.push(client);
    const initial = await client.initialSnapshot;
    expect(initial.type === 'snapshot' && initial.session.messages?.map((message) => message.content)).toEqual(['message 0', 'message 1']);
    expect(initial.type === 'snapshot' && initial.saved).toBeUndefined();
    const heard: string[] = [];
    client.on('event', (event: WorkerEvent) => heard.push(event.type));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard).toEqual(['delta']);
  });

  it('asks the worker for this by saying so on attach', async () => {
    const id = randomUUID();
    const worker = await standInWorker(id, (socket, command) => { if (command.type === 'attach') socket.write(snapshot(id)); });
    clients.push((await WorkerClient.attachExisting(id))!);
    expect(worker.seen[0]?.command).toEqual({ type: 'attach', token: TOKEN, readsSaved: true });
  });

  it('reads again before believing a transcript shorter than the worker saw, then takes what is there', async () => {
    const sessionId = await savedConversation(2);
    await standInWorker(sessionId, (socket, command) => {
      if (command.type === 'attach') socket.write(snapshot(sessionId, { saved: { count: 5 } }));
    });
    const client = (await WorkerClient.attachExisting(sessionId))!;
    clients.push(client);
    const initial = await client.initialSnapshot;
    expect(initial.type === 'snapshot' && initial.session.messages).toHaveLength(2);
  });

  it('is delivered whole when the worker sent it whole (an older worker)', async () => {
    const id = randomUUID();
    await standInWorker(id, (socket, command) => {
      if (command.type === 'attach') socket.write(encodeFrame({ type: 'snapshot', session: { id, messages: [{ role: 'user', content: 'hi' }] } as unknown as HarnessSession }));
    });
    const client = (await WorkerClient.attachExisting(id))!;
    clients.push(client);
    const initial = await client.initialSnapshot;
    expect(initial.type === 'snapshot' && initial.session.messages).toHaveLength(1);
  });
});

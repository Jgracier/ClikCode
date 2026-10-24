/** A worker that takes the connection and never answers is replaced, and a worker that dies at
 * startup says why. The silent worker is a real process (killed by the pid in its record); the
 * replacement is a script that fails on purpose. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { process.env.CLIKCODE_ATTACH_ANSWER_MS = '300'; process.env.CLIKCODE_OWN_SCOPE = '0'; });

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import { WorkerClient } from './client.js';
import { currentWorkerBuild, ensureWorkersDirectory, socketPathFor, writeWorkerRecord } from './registry.js';

const previous = { home: process.env.CLIKCODE_HOME, entry: process.env.CLIKCODE_WORKER_ENTRY };
let root: string;
let server: Server | undefined;
let silent: ChildProcess | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clikcode-takeover-'));
  process.env.CLIKCODE_HOME = root;
});

afterEach(async () => {
  silent?.kill('SIGKILL');
  silent = undefined;
  await new Promise((resolve) => { if (!server) resolve(undefined); else { server.close(resolve); server.closeAllConnections?.(); } });
  server = undefined;
  if (previous.home === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous.home;
  if (previous.entry === undefined) delete process.env.CLIKCODE_WORKER_ENTRY; else process.env.CLIKCODE_WORKER_ENTRY = previous.entry;
  await rm(root, { recursive: true, force: true });
});

async function savedConversation(): Promise<string> {
  const state = await readState();
  const now = new Date().toISOString();
  const id = randomUUID();
  state.sessions.push({
    id, conversationId: id, route: 'local', accountId: null, provider: null, model: null, effort: 'medium',
    permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active', messages: [{ role: 'user', content: 'hi' }],
  } as HarnessSession);
  await writeState(state);
  return id;
}

describe('a worker that accepts the connection and never answers', () => {
  it('is ended by the pid in its record after the second silent attach, and its replacement\'s startup failure is said', async () => {
    const id = await savedConversation();
    silent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = silent.pid!;
    await ensureWorkersDirectory();
    server = createServer((socket) => { socket.on('data', () => undefined); socket.on('error', () => undefined); });
    await new Promise<void>((resolve) => server!.listen(socketPathFor(id), resolve));
    await writeWorkerRecord({
      pid, sessionId: id, socketPath: socketPathFor(id), installationId: 'stand-in',
      startedAt: new Date().toISOString(), token: 'silent', ...(currentWorkerBuild() ? { build: currentWorkerBuild()! } : {}),
    });
    // The replacement dies at startup, saying why.
    const entry = join(root, 'failing-worker.mjs');
    await writeFile(entry, "console.error('RangeError: worker killed with exit code 137 (out of memory)'); process.exit(3);\n");
    process.env.CLIKCODE_WORKER_ENTRY = entry;

    const failure = await WorkerClient.attach(id).then(() => 'attached', (error: Error) => error.message);
    expect(failure).toContain('did not start in time');
    expect(failure).toContain('worker killed with exit code 137 (out of memory)');
    // The silent worker is gone.
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
  }, 30_000);
});

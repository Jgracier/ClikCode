import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLocalModel, holdRunningLocalModel, releaseLocalModelTurn } from './index';
import { serverDir, startSupervisor } from './lifecycle';

// A model already running (a supervisor over a stand-in server that answers /health), joined the way a turn worker and a window join it.
const MODEL = 'qwen3.5-4b';
const previous = process.env.CLIKCODE_LOCAL_MODELS_HOME;
let running: { supervisorPid: number; serverPid: number } | undefined;

beforeEach(() => { process.env.CLIKCODE_LOCAL_MODELS_HOME = mkdtempSync(join(tmpdir(), 'cc-turn-lease-')); });
afterEach(() => {
  for (const pid of [running?.serverPid, running?.supervisorPid]) { try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  running = undefined;
  if (previous === undefined) delete process.env.CLIKCODE_LOCAL_MODELS_HOME;
  else process.env.CLIKCODE_LOCAL_MODELS_HOME = previous;
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
  });
}

async function runningModel(): Promise<void> {
  const port = await freePort();
  const dir = serverDir(MODEL);
  mkdirSync(join(dir, 'leases'), { recursive: true });
  // The supervisor exits when it finds no lease: one exists before it starts, as the engine writes it.
  writeFileSync(join(dir, 'leases', `${process.pid}-starter.json`), '{}');
  running = await startSupervisor({
    modelId: MODEL, dir, command: process.execPath, port, alias: MODEL, context: 8192, env: {}, idleMs: 0, pollMs: 100,
    args: ['-e', `require('http').createServer((request, response) => response.end('ok')).listen(${port}, '127.0.0.1')`],
  } as never);
  // Listening before it is joined.
  for (let waited = 0; waited < 5000; waited += 100) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok, () => false)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
}

const leaseOf = (name: string): boolean => existsSync(join(serverDir(MODEL), 'leases', name));

describe('joining a running model', () => {
  it('a turn takes its own lease for the turn, whether or not a window holds the chat, and gives only that back', async () => {
    await runningModel();
    // The window already holds the chat (a lease of another live process: pid 1 is always alive).
    writeFileSync(join(serverDir(MODEL), 'leases', '1-s1.json'), '{}');
    const endpoint = await ensureLocalModel({ modelId: MODEL, sessionId: 's1', forTurn: true });
    expect(endpoint.model).toBe(MODEL);
    expect(leaseOf(`${process.pid}-turn-s1.json`)).toBe(true);
    // Not a hold on the chat: the worker must not keep a model up for as long as it lives.
    expect(leaseOf(`${process.pid}-s1.json`)).toBe(false);
    await releaseLocalModelTurn('s1');
    expect(leaseOf(`${process.pid}-turn-s1.json`)).toBe(false);
    expect(leaseOf('1-s1.json')).toBe(true);
  }, 30_000);

  it('a window still joins a chat another process shows without a second lease of its own', async () => {
    await runningModel();
    writeFileSync(join(serverDir(MODEL), 'leases', '1-s1.json'), '{}');
    await ensureLocalModel({ modelId: MODEL, sessionId: 's1' });
    expect(leaseOf(`${process.pid}-s1.json`)).toBe(false);
    await ensureLocalModel({ modelId: MODEL, sessionId: 's2' });
    expect(leaseOf(`${process.pid}-s2.json`)).toBe(true);
  }, 30_000);

  it('a window holds the model a turn brought up, only if it is running, and starts nothing', async () => {
    expect(await holdRunningLocalModel('s1', MODEL)).toBe(false);
    expect(leaseOf(`${process.pid}-s1.json`)).toBe(false);
    await runningModel();
    expect(await holdRunningLocalModel('s1', MODEL)).toBe(true);
    expect(leaseOf(`${process.pid}-s1.json`)).toBe(true);
  }, 30_000);
});

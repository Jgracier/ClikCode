import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveWorkers, liveWorkerSessions, livePendingTurns, sessionActivity } from './liveness.js';
import type { HarnessSession } from './model.js';
import { ensureWorkersDirectory, writeWorkerRecord } from '../worker/registry.js';

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('liveWorkerSessions reads the worker directory once', () => {
  it('reports only workers whose process is still alive', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-live-workers-'));
    process.env.CLIKCODE_HOME = root;
    await ensureWorkersDirectory();
    await writeWorkerRecord({
      sessionId: 'alive',
      pid: process.pid,
      socketPath: join(root, 'alive.sock'),
      token: 't',
      installationId: 'install',
      build: 'test',
      startedAt: new Date().toISOString(),
    });
    await writeWorkerRecord({
      sessionId: 'dead',
      pid: 2_147_483_646,
      socketPath: join(root, 'dead.sock'),
      token: 't',
      installationId: 'install',
      build: 'test',
      startedAt: new Date().toISOString(),
    });
    const live = await liveWorkerSessions();
    expect(live('alive')).toBe(true);
    expect(live('dead')).toBe(false);
    expect(live('chat-0')).toBe(false);
  });
});

it('does not call a failed turn working when its worker remains open', () => {
  const now = new Date().toISOString();
  const session = {
    id: 'chat', status: 'active', pendingTurn: { prompt: 'go', startedAt: now, updatedAt: now, outputStarted: true, failedAt: now },
  } as HarnessSession;
  const marked = () => now;
  expect(sessionActivity(session, () => true, session.pendingTurn, () => false, marked)).toBe('idle');
  delete session.pendingTurn!.failedAt;
  expect(sessionActivity(session, () => true, session.pendingTurn, () => false, marked)).toBe('working');
});

describe('a chat whose turn is over but whose background work runs', () => {
  it('stays among the working ones, its agents counted, until the worker says the work is done', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-live-background-'));
    process.env.CLIKCODE_HOME = root;
    await ensureWorkersDirectory();
    const record = { sessionId: 'waiting', pid: process.pid, socketPath: join(root, 'w.sock'), token: 't', installationId: 'install', build: 'test', startedAt: new Date().toISOString() };
    await writeWorkerRecord({ ...record, background: { agents: 2, terminals: 1, since: '2026-10-17T10:00:00.000Z' } });
    const session = { id: 'waiting', status: 'active' } as HarnessSession;
    let workers = await liveWorkers();
    let pending = await livePendingTurns([session], workers.isLive, workers.background, workers.runningTurn);
    expect(pending.get('waiting')).toMatchObject({ startedAt: '2026-10-17T10:00:00.000Z' });
    expect(pending.get('waiting')?.subagents).toHaveLength(2);
    expect(sessionActivity(session, workers.isLive, pending.get('waiting'), workers.isOpen, workers.runningTurn, workers.background)).toBe('working');
    await writeWorkerRecord(record);
    workers = await liveWorkers();
    pending = await livePendingTurns([session], workers.isLive, workers.background, workers.runningTurn);
    expect(pending.has('waiting')).toBe(false);
  });

  it('does not treat a stale pending journal as a live turn without the worker turn marker', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-idle-worker-'));
    process.env.CLIKCODE_HOME = root;
    await ensureWorkersDirectory();
    await writeWorkerRecord({ sessionId: 'idle', pid: process.pid, socketPath: join(root, 'idle.sock'), token: 't', installationId: 'install', build: 'test', startedAt: new Date().toISOString() });
    const session = { id: 'idle', status: 'active', pendingTurn: { prompt: 'stale', startedAt: '2026-10-26T12:00:00.000Z', updatedAt: '2026-10-26T12:00:00.000Z', outputStarted: true } } as HarnessSession;
    const workers = await liveWorkers();
    const pending = await livePendingTurns([session], workers.isLive, workers.background, workers.runningTurn);
    expect(pending.has('idle')).toBe(false);
    expect(sessionActivity(session, workers.isLive, pending.get('idle'), workers.isOpen, workers.runningTurn)).toBe('idle');
  });
});

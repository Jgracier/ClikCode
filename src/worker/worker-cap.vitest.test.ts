/** More workers than the cap: the least recently used one that holds nothing
 * goes even with a terminal attached, and that terminal's next attach (its
 * next message) starts it again. Real spawned workers, in a home of their own. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import { forceStoreSession, unforceStoreSession } from '../session/ephemeral.js';
import { WorkerClient } from './client.js';
import { readWorkerRecord } from './registry.js';
import { OVER_CAP_REASON } from './worker-idle.js';
import type { WorkerEvent } from './protocol.js';

const saved = { home: process.env.CLIKCODE_HOME, entry: process.env.CLIKCODE_WORKER_ENTRY, cap: process.env.CLIKCODE_MAX_WORKERS, watch: process.env.CLIKCODE_WORKER_BUILD_WATCH_MS };
const restore = (name: string, value: string | undefined): void => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = join(repoRoot, 'dist', 'index.js');
let root: string | undefined;
const clients: WorkerClient[] = [];
const sessions: string[] = [];

beforeAll(async () => {
  process.env.CLIKCODE_WORKER_ENTRY = distEntry;
  if (!await access(distEntry).then(() => true, () => false)) await promisify(execFile)('node', ['scripts/build.mjs'], { cwd: repoRoot });
}, 30_000);
afterAll(() => {
  restore('CLIKCODE_WORKER_ENTRY', saved.entry);
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const id of sessions.splice(0)) {
    const record = await readWorkerRecord(id).catch(() => undefined);
    if (record) { try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ } }
    unforceStoreSession(id);
  }
  restore('CLIKCODE_HOME', saved.home);
  restore('CLIKCODE_MAX_WORKERS', saved.cap);
  restore('CLIKCODE_WORKER_BUILD_WATCH_MS', saved.watch);
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function stored(): Promise<HarnessSession> {
  const state = await readState();
  const now = new Date().toISOString();
  const session: HarnessSession = {
    id: randomUUID(), conversationId: randomUUID(), route: 'local', accountId: null, provider: null, model: null,
    effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
  };
  state.sessions.push(session);
  forceStoreSession(session.id);
  await writeState(state);
  sessions.push(session.id);
  return session;
}

describe('the cap on live workers', () => {
  it('retires the least recently used idle worker under a terminal, and the terminal gets a new one when it next attaches', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-worker-cap-'));
    process.env.CLIKCODE_HOME = root;
    process.env.CLIKCODE_MAX_WORKERS = '1';
    process.env.CLIKCODE_WORKER_BUILD_WATCH_MS = '200';
    const older = await stored();
    const newer = await stored();
    const first = await WorkerClient.attach(older.id, { reattaches: true });
    clients.push(first);
    await first.initialSnapshot;
    const retiredPid = (await readWorkerRecord(older.id))!.pid;
    const shutdown = new Promise<WorkerEvent>((resolveEvent) => first.on('event', (event: WorkerEvent) => { if (event.type === 'shutdown') resolveEvent(event); }));
    const closed = new Promise<void>((resolveClosed) => first.once('close', () => resolveClosed()));
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    // An editor panel's window (it does not attach again by itself) holds its worker.
    const second = await WorkerClient.attach(newer.id);
    clients.push(second);
    await second.initialSnapshot;
    expect(await shutdown).toMatchObject({ reason: OVER_CAP_REASON });
    await closed;
    const kept = await readWorkerRecord(newer.id);
    expect(kept).toBeDefined();
    // The terminal's next message attaches (and so starts) a worker again.
    const again = await WorkerClient.attach(older.id, { reattaches: true });
    clients.push(again);
    expect(await again.initialSnapshot).toMatchObject({ type: 'snapshot', session: { id: older.id } });
    expect((await readWorkerRecord(older.id))?.pid).not.toBe(retiredPid);
  }, 30_000);
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import { WorkerClient } from './client.js';
import { readWorkerRecord } from './registry.js';
import type { WorkerEvent } from './protocol.js';

const previousHome = process.env.CLIKCODE_HOME;
const previousWorkerEntry = process.env.CLIKCODE_WORKER_ENTRY;
let root: string | undefined;
const spawnedClients: WorkerClient[] = [];
/** Every session id this file has spawned a worker for, so afterEach can
 * actually terminate each one -- closing the WorkerClient only disconnects;
 * the worker itself is designed to keep running for up to 30 idle minutes
 * (see IDLE_EXIT_MS in session-worker.ts), which is correct in production
 * and exactly wrong left to itself in a test suite run over and over. A
 * real run of this file once left 70+ of these alive on a real machine
 * before this existed -- confirmed live, not a hypothetical. */
const spawnedSessionIds: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = join(repoRoot, 'dist', 'index.js');

async function terminateSpawnedWorkers(): Promise<void> {
  for (const sessionId of spawnedSessionIds.splice(0)) {
    const record = await readWorkerRecord(sessionId).catch(() => undefined);
    if (record) { try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ } }
  }
}

beforeAll(async () => {
  // vitest's own process.argv[1] is not a runnable clikcode entry (this
  // repo's .js-suffixed source imports do not resolve against sibling .ts
  // files under plain `node file.ts`, so a raw-source entry is not an
  // option -- see client.ts). Point spawnSessionWorker at a real build
  // instead, building fresh only if dist/index.js is not already there;
  // esbuild is fast enough (double-digit milliseconds) that this never
  // meaningfully slows the suite down when it does need to run.
  process.env.CLIKCODE_WORKER_ENTRY = distEntry;
  const alreadyBuilt = await access(distEntry).then(() => true, () => false);
  if (!alreadyBuilt) await promisify(execFile)('node', ['scripts/build.mjs'], { cwd: repoRoot });
}, 30_000);

afterAll(() => {
  if (previousWorkerEntry === undefined) delete process.env.CLIKCODE_WORKER_ENTRY;
  else process.env.CLIKCODE_WORKER_ENTRY = previousWorkerEntry;
});

afterEach(async () => {
  for (const client of spawnedClients.splice(0)) client.close();
  // Must run while CLIKCODE_HOME still points at this test's own temp
  // directory -- readWorkerRecord looks the record up under it.
  await terminateSpawnedWorkers();
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function isolatedSession(): Promise<HarnessSession> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-worker-e2e-'));
  process.env.CLIKCODE_HOME = root;
  const state = await readState();
  const now = new Date().toISOString();
  const session: HarnessSession = {
    id: randomUUID(), conversationId: randomUUID(), route: 'local', accountId: null, provider: null, model: null,
    effort: 'medium', permissionMode: 'ask', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
  };
  state.sessions.push(session);
  await writeState(state);
  spawnedSessionIds.push(session.id);
  return session;
}

/** Waits for the next event of a given type, or throws after a bounded time
 * -- a hung worker must fail the test, not hang the whole suite. */
function nextEvent(client: WorkerClient, type: WorkerEvent['type'], timeoutMs = 8_000): Promise<WorkerEvent> {
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => rejectEvent(new Error(`timed out waiting for "${type}"`)), timeoutMs);
    const onEvent = (event: WorkerEvent): void => {
      if (event.type !== type) return;
      clearTimeout(timer);
      client.off('event', onEvent);
      resolveEvent(event);
    };
    client.on('event', onEvent);
  });
}

describe('session worker (real spawned process, real socket)', () => {
  it('spawns on first attach and answers with a snapshot of the real session', async () => {
    const session = await isolatedSession();
    const client = await WorkerClient.attach(session.id);
    spawnedClients.push(client);
    const snapshot = await client.initialSnapshot;
    expect(snapshot).toMatchObject({ type: 'snapshot', session: { id: session.id } });
  });

  it('a second attach finds the same already-running worker instead of spawning another', async () => {
    const session = await isolatedSession();
    const first = await WorkerClient.attach(session.id);
    spawnedClients.push(first);
    await first.initialSnapshot;
    const recordAfterFirst = await readWorkerRecord(session.id);

    const second = await WorkerClient.attach(session.id);
    spawnedClients.push(second);
    await second.initialSnapshot;
    const recordAfterSecond = await readWorkerRecord(session.id);

    // Same worker process both times -- proven by the same pid still owning
    // the registry record, not a second one having overwritten it.
    expect(recordAfterSecond?.pid).toBe(recordAfterFirst?.pid);
  });

  it('rejects an attach carrying the wrong token', async () => {
    const session = await isolatedSession();
    const legitimate = await WorkerClient.attach(session.id);
    spawnedClients.push(legitimate);
    await legitimate.initialSnapshot;

    // A second, independent connection to the SAME socket, but with a
    // deliberately wrong token -- simulates a stale/forged record rather
    // than the normal spawn-or-find path.
    const record = await readWorkerRecord(session.id);
    expect(record).toBeDefined();
    const { connect } = await import('node:net');
    const { encodeFrame, decodeFrames } = await import('./protocol.js');
    const rogueSocket = connect(record!.socketPath);
    await new Promise<void>((resolveConnect) => rogueSocket.once('connect', () => resolveConnect()));
    const rejected = new Promise<void>((resolveRejected) => {
      let buffer = '';
      rogueSocket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const { messages } = decodeFrames(buffer);
        if (messages.some((m) => (m as WorkerEvent).type === 'attach-rejected')) resolveRejected();
      });
    });
    rogueSocket.write(encodeFrame({ type: 'attach', token: 'definitely-not-the-real-token' }));
    await rejected;
    rogueSocket.destroy();
  });

  it('broadcasts a render() to every attached client, not just the most recent one', async () => {
    const session = await isolatedSession();
    const first = await WorkerClient.attach(session.id);
    spawnedClients.push(first);
    await first.initialSnapshot;
    const second = await WorkerClient.attach(session.id);
    spawnedClients.push(second);
    await second.initialSnapshot;

    // A refresh asks the worker to re-render from disk; both attached
    // clients should see it, proving the broadcast reaches every socket,
    // not just whichever one most recently attached.
    first.send({ type: 'refresh' });
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      nextEvent(first, 'snapshot'),
      nextEvent(second, 'snapshot'),
    ]);
    expect(firstSnapshot).toMatchObject({ session: { id: session.id } });
    expect(secondSnapshot).toMatchObject({ session: { id: session.id } });
  });

  it('a submit that fails immediately still completes the waiting-start/stop lifecycle', async () => {
    // No account configured on this session, so aiGatewaySessionSend rejects
    // right away ("local AI session has no account selected") -- exercises
    // the real failure path (not a happy-path mock): the worker must still
    // bracket it with waiting-start/waiting-stop and report a turn-error,
    // not hang or crash.
    const session = await isolatedSession();
    const client = await WorkerClient.attach(session.id);
    spawnedClients.push(client);
    await client.initialSnapshot;

    client.send({ type: 'submit', text: 'hello', echo: true });
    const started = nextEvent(client, 'waiting-start');
    const errored = nextEvent(client, 'turn-error');
    const stopped = nextEvent(client, 'waiting-stop');
    await expect(started).resolves.toMatchObject({ type: 'waiting-start' });
    await expect(errored).resolves.toMatchObject({ type: 'turn-error' });
    await expect(stopped).resolves.toMatchObject({ type: 'waiting-stop' });
  });

  it('a cancel with no turn running is a harmless no-op, not an error', async () => {
    const session = await isolatedSession();
    const client = await WorkerClient.attach(session.id);
    spawnedClients.push(client);
    await client.initialSnapshot;

    client.send({ type: 'cancel', restoreDraft: false });
    // Nothing to assert an absence of directly -- prove the worker is still
    // alive and answering normally afterward, which a crash or a hang from
    // the cancel would have broken.
    client.send({ type: 'refresh' });
    await expect(nextEvent(client, 'snapshot')).resolves.toMatchObject({ session: { id: session.id } });
  });

});

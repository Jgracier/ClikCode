import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import { forceStoreSession, unforceStoreSession } from '../session/ephemeral.js';
import { WorkerClient, retireStaleWorkers } from './client.js';
import { readWorkerRecord, takeConversation, workerIsReachable, writeWorkerRecord } from './registry.js';
import { connect } from 'node:net';
import { encodeFrame, FrameDecoder, type ClientCommand, type WorkerEvent } from './protocol.js';

const previousHome = process.env.CLIKCODE_HOME;
const previousWorkerEntry = process.env.CLIKCODE_WORKER_ENTRY;
let root: string | undefined;
const spawnedClients: WorkerClient[] = [];
/** Every session id this file has spawned a worker for, so afterEach can
 * actually terminate each one -- closing the WorkerClient only disconnects;
 * the worker itself is designed to keep running for up to 30 idle minutes
 * (see IDLE_EXIT_MS in worker-idle.ts), which is correct in production
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
    unforceStoreSession(sessionId);
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

async function isolatedSession(messages?: HarnessSession['messages']): Promise<HarnessSession> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-worker-e2e-'));
  process.env.CLIKCODE_HOME = root;
  const state = await readState();
  const now = new Date().toISOString();
  const session: HarnessSession = {
    id: randomUUID(), conversationId: randomUUID(), route: 'local', accountId: null, provider: null, model: null,
    effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
    ...(messages ? { messages } : {}),
  };
  state.sessions.push(session);
  // A blank draft is normally process-local. The test launches a separate
  // worker, so store the draft as the production worker handoff does.
  forceStoreSession(session.id);
  await writeState(state);
  spawnedSessionIds.push(session.id);
  return session;
}

/** What a worker sends back to a connection that sends `commands` and nothing
 * else: every event until it closes the connection or `ms` pass. */
async function exchange(sessionId: string, commands: (token: string) => ClientCommand[], ms = 600): Promise<WorkerEvent[]> {
  const record = (await readWorkerRecord(sessionId))!;
  const socket = connect(record.socketPath);
  await new Promise<void>((resolveConnect) => socket.once('connect', () => resolveConnect()));
  const events: WorkerEvent[] = [];
  const frames = new FrameDecoder();
  const ended = new Promise<void>((resolveEnded) => {
    socket.on('data', (chunk) => { for (const message of frames.push(chunk)) events.push(message as WorkerEvent); });
    socket.on('close', () => resolveEnded());
    socket.on('error', () => resolveEnded());
    setTimeout(resolveEnded, ms);
  });
  for (const command of commands(record.token)) socket.write(encodeFrame(command));
  await ended;
  socket.destroy();
  return events;
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

  it('stores a new chat that is still a draft here before its worker looks for it', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-worker-e2e-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    const draft: HarnessSession = {
      id: randomUUID(), conversationId: randomUUID(), route: 'local', accountId: null, provider: null, model: null,
      effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
    };
    state.sessions.push(draft);
    // Held in this process only, as a window holds a chat nothing was sent in.
    await writeState(state);
    spawnedSessionIds.push(draft.id);
    const client = await WorkerClient.attach(draft.id);
    spawnedClients.push(client);
    expect(await readWorkerRecord(draft.id)).toBeDefined();
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

  it('retires a worker running a different build and spawns a replacement', async () => {
    const session = await isolatedSession();
    const first = await WorkerClient.attach(session.id);
    spawnedClients.push(first);
    await first.initialSnapshot;
    const before = await readWorkerRecord(session.id);
    expect(before?.build).toBeTruthy();

    // What a reinstall looks like from the client's side: the worker is
    // running code from a different build of the entry it loaded.
    await writeWorkerRecord({ ...before!, build: 'a-different-build' });
    const second = await WorkerClient.attach(session.id);
    spawnedClients.push(second);
    await second.initialSnapshot;
    const after = await readWorkerRecord(session.id);

    expect(after?.pid).not.toBe(before?.pid);
    expect(after?.build).toBe(before?.build);
  });

  it('retires an idle stale-build worker whatever the journal says', async () => {
    const session = await isolatedSession();
    const first = await WorkerClient.attach(session.id);
    spawnedClients.push(first);
    await first.initialSnapshot;
    const before = await readWorkerRecord(session.id);

    const state = await readState();
    const stored = state.sessions.find((item) => item.id === session.id)!;
    const now = new Date().toISOString();
    stored.pendingTurn = { prompt: 'mid answer', startedAt: now, updatedAt: now, outputStarted: true };
    await writeState(state);
    await writeWorkerRecord({ ...before!, build: 'a-different-build' });

    const second = await WorkerClient.attach(session.id);
    spawnedClients.push(second);
    await second.initialSnapshot;

    // A journal left by an interrupted turn is not a running turn: the
    // worker knows it is idle, and steps down. (A worker really mid-turn is
    // kept: session-worker-waiting.vitest.test.ts.)
    expect((await readWorkerRecord(session.id))?.pid).not.toBe(before?.pid);
  });

  it('retireStaleWorkers steps down every idle worker on another build', async () => {
    // Left on the board, and the rebuild notice, both call this: chats you
    // never reopen must not keep the old code for the idle timeout.
    const first = await isolatedSession();
    // Same home as `first`: a second isolatedSession() would replace
    // CLIKCODE_HOME and hide the first worker from the sweep.
    const state = await readState();
    const now = new Date().toISOString();
    const second: HarnessSession = {
      id: randomUUID(), conversationId: randomUUID(), route: 'local', accountId: null, provider: null, model: null,
      effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
    };
    state.sessions.push(second);
    forceStoreSession(second.id);
    await writeState(state);
    spawnedSessionIds.push(second.id);

    const clientA = await WorkerClient.attach(first.id);
    const clientB = await WorkerClient.attach(second.id);
    spawnedClients.push(clientA, clientB);
    await clientA.initialSnapshot;
    await clientB.initialSnapshot;
    const beforeA = (await readWorkerRecord(first.id))!;
    const beforeB = (await readWorkerRecord(second.id))!;
    expect(beforeA.build).toBeTruthy();
    clientA.close();
    clientB.close();
    await writeWorkerRecord({ ...beforeA, build: 'a-different-build' });
    await writeWorkerRecord({ ...beforeB, build: 'a-different-build' });
    await retireStaleWorkers();
    expect(await workerIsReachable(beforeA.socketPath, 200)).toBe(false);
    expect(await workerIsReachable(beforeB.socketPath, 200)).toBe(false);
  }, 15_000);

  it('keeps a message typed as the turn ended, instead of dropping it', async () => {
    // The race: Enter during the last moment of a turn, and the steer lands
    // after the worker has stopped. It used to be silently discarded.
    const session = await isolatedSession();
    const client = await WorkerClient.attach(session.id);
    spawnedClients.push(client);
    await client.initialSnapshot;
    const answer = nextEvent(client, 'submission');
    client.send({ type: 'steer', text: 'also check the tests', id: 'msg-1' });
    expect(await answer).toMatchObject({ type: 'submission', id: 'msg-1', disposition: 'queued' });
    const stored = (await readState()).sessions.find((item) => item.id === session.id);
    expect(stored?.queuedTurns?.map((item) => item.text)).toEqual(['also check the tests']);
  });

  it('takes a queued message back out of the queue for every window', async () => {
    const session = await isolatedSession();
    const client = await WorkerClient.attach(session.id);
    spawnedClients.push(client);
    await client.initialSnapshot;
    const queued = nextEvent(client, 'submission');
    client.send({ type: 'steer', text: 'never mind this', id: 'msg-2' });
    await queued;
    const changed = nextEvent(client, 'snapshot');
    const removed = nextEvent(client, 'unqueued');
    client.send({ type: 'unqueue', id: 'msg-2' });
    expect(await removed).toMatchObject({ type: 'unqueued', id: 'msg-2', outcome: 'removed' });
    const snapshot = await changed as Extract<WorkerEvent, { type: 'snapshot' }>;
    expect(snapshot.session.queuedTurns ?? []).toEqual([]);
    const stored = (await readState()).sessions.find((item) => item.id === session.id);
    expect(stored?.queuedTurns ?? []).toEqual([]);
    // Asked again, it is no longer there: still answered, so the window
    // asking does not wait on a reply that never comes.
    const gone = nextEvent(client, 'unqueued');
    client.send({ type: 'unqueue', id: 'msg-2' });
    expect(await gone).toMatchObject({ type: 'unqueued', id: 'msg-2', outcome: 'gone' });
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
    const { encodeFrame, FrameDecoder } = await import('./protocol.js');
    const rogueSocket = connect(record!.socketPath);
    await new Promise<void>((resolveConnect) => rogueSocket.once('connect', () => resolveConnect()));
    const rejected = new Promise<void>((resolveRejected) => {
      const frames = new FrameDecoder();
      rogueSocket.on('data', (chunk) => {
        if (frames.push(chunk).some((m) => (m as WorkerEvent).type === 'attach-rejected')) resolveRejected();
      });
    });
    rogueSocket.write(encodeFrame({ type: 'attach', token: 'definitely-not-the-real-token' }));
    await rejected;
    rogueSocket.destroy();
  });

  it('sends a window that reads the saved conversation a snapshot without its messages, and an older window all of it', async () => {
    const messages = Array.from({ length: 4 }, (_, index) => ({ role: index % 2 === 0 ? 'user' as const : 'assistant' as const, content: `message ${index}` }));
    const session = await isolatedSession(messages);
    const first = await WorkerClient.attach(session.id);
    spawnedClients.push(first);
    // A window hands its consumers the whole conversation, whichever way it travelled.
    const initial = await first.initialSnapshot;
    expect(initial.type === 'snapshot' && initial.session.messages?.map((message) => message.content)).toEqual(['message 0', 'message 1', 'message 2', 'message 3']);

    const [slim] = await exchange(session.id, (token) => [{ type: 'attach', token, readsSaved: true }]);
    const [whole] = await exchange(session.id, (token) => [{ type: 'attach', token }]);
    expect(slim).toMatchObject({ type: 'snapshot', saved: { count: 4 } });
    expect(slim?.type === 'snapshot' && slim.session.messages).toBeUndefined();
    expect(whole?.type === 'snapshot' && whole.session.messages).toHaveLength(4);
    expect(whole?.type === 'snapshot' && whole.saved).toBeUndefined();
  });

  it('attaches to a conversation too large to send whole, and stays attached when another snapshot follows', async () => {
    // Past the worker's 16 MiB unread limit, which is what used to cut a window off.
    const large = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 === 0 ? 'user' as const : 'assistant' as const, content: `${index}:${'x'.repeat(1_000_000)}` }));
    const session = await isolatedSession(large);
    const client = await WorkerClient.attach(session.id);
    spawnedClients.push(client);
    const initial = await client.initialSnapshot;
    expect(initial.type === 'snapshot' && initial.session.messages).toHaveLength(20);

    let closed = false;
    client.on('close', () => { closed = true; });
    const next = nextEvent(client, 'snapshot', 15_000);
    client.send({ type: 'refresh' });
    const again = await next;
    expect(again.type === 'snapshot' && again.session.messages).toHaveLength(20);
    expect(closed).toBe(false);
  }, 60_000);

  it('answers a retire question on its own to the asker, with no snapshot, and an idle worker goes', async () => {
    const session = await isolatedSession();
    const client = await WorkerClient.attach(session.id);
    spawnedClients.push(client);
    await client.initialSnapshot;
    const record = (await readWorkerRecord(session.id))!;
    client.close();

    const events = await exchange(session.id, (token) => [{ type: 'retire', token }], 3_000);
    // Answered to the asker directly, and never with a snapshot. A worker that has only just started is still
    // reading its queue and says so (`retire-declined`) -- which also marks it to go as soon as it is not.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.type === 'shutdown' || event.type === 'retire-declined')).toBe(true);
    for (let waited = 0; waited < 5_000 && await workerIsReachable(record.socketPath, 200); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await workerIsReachable(record.socketPath, 200)).toBe(false);
  }, 20_000);

  it('rejects a retire question with the wrong token, and the worker stays', async () => {
    const session = await isolatedSession();
    const client = await WorkerClient.attach(session.id);
    spawnedClients.push(client);
    await client.initialSnapshot;
    const record = (await readWorkerRecord(session.id))!;

    const events = await exchange(session.id, () => [{ type: 'retire', token: 'definitely-not-the-real-token' }]);
    expect(events.map((event) => event.type)).toEqual(['attach-rejected']);
    expect(await workerIsReachable(record.socketPath, 500)).toBe(true);
  });

  it('broadcasts a render() to every attached client, not just the most recent one', async () => {
    const session = await isolatedSession();
    const first = await WorkerClient.attach(session.id);
    spawnedClients.push(first);
    await first.initialSnapshot;
    const second = await WorkerClient.attach(session.id);
    spawnedClients.push(second);
    await second.initialSnapshot;

    // One window changed the conversation's settings (a /model, an account
    // swap) and sends refresh: the worker re-reads state and every attached
    // window -- not just the most recent one -- gets the new settings.
    const state = await readState();
    const stored = state.sessions.find((item) => item.id === session.id)!;
    stored.model = 'changed-in-another-window';
    await writeState(state);
    first.send({ type: 'refresh' });
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      nextEvent(first, 'snapshot'),
      nextEvent(second, 'snapshot'),
    ]);
    expect(firstSnapshot).toMatchObject({ session: { id: session.id, model: 'changed-in-another-window' } });
    expect(secondSnapshot).toMatchObject({ session: { id: session.id, model: 'changed-in-another-window' } });
  });

  it('a submit that fails immediately still completes the waiting-start/stop lifecycle', async () => {
    // No account configured on this session, so runSessionTurn rejects
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

describe('one worker per conversation', () => {
  const children: ChildProcess[] = [];
  // Waited out before the file's own afterEach removes the directory: a
  // worker shutting down still writes its state there, and recreates it.
  afterEach(async () => {
    await Promise.all(children.splice(0).map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return undefined;
      child.kill('SIGTERM');
      return new Promise((resolveExit) => child.once('exit', resolveExit));
    }));
  });

  /** A worker started directly, as two windows racing to spawn one do. */
  const startWorker = (sessionId: string): ChildProcess => {
    const child = spawn(process.execPath, [distEntry, 'session-worker', sessionId], { stdio: 'ignore', env: process.env });
    children.push(child);
    return child;
  };
  const exited = (child: ChildProcess): Promise<number | null> => child.exitCode !== null
    ? Promise.resolve(child.exitCode) : new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  const until = async (condition: () => Promise<boolean>, what: string, timeoutMs = 8_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!await condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  };
  const serving = async (sessionId: string): Promise<boolean> => {
    const record = await readWorkerRecord(sessionId);
    return Boolean(record && await workerIsReachable(record.socketPath));
  };

  it('three started at once: one serves the conversation and the others exit', async () => {
    const session = await isolatedSession();
    const started = [startWorker(session.id), startWorker(session.id), startWorker(session.id)];
    await until(() => serving(session.id), 'a worker to serve');
    const record = await readWorkerRecord(session.id);
    const winner = started.find((child) => child.pid === record?.pid);
    expect(winner, 'the record names none of the workers started').toBeDefined();
    for (const loser of started.filter((child) => child !== winner)) expect(await exited(loser)).toBe(0);
    expect(winner!.exitCode, 'the worker serving the conversation exited').toBeNull();
    // The survivor is the one windows reach, and its socket was never taken.
    const client = await WorkerClient.attach(session.id);
    spawnedClients.push(client);
    expect(await client.initialSnapshot).toMatchObject({ type: 'snapshot', session: { id: session.id } });
    expect((await readWorkerRecord(session.id))?.pid).toBe(record?.pid);
  });

  it('a worker shutting down leaves a record that is not its own', async () => {
    const session = await isolatedSession();
    const worker = startWorker(session.id);
    await until(() => serving(session.id), 'the worker to serve');
    const record = (await readWorkerRecord(session.id))!;
    const replacement = { ...record, pid: record.pid + 100_000, token: 'the replacement' };
    await writeWorkerRecord(replacement);
    worker.kill('SIGTERM');
    expect(await exited(worker)).toBe(0);
    expect(await readWorkerRecord(session.id)).toEqual(replacement);
  });

  it('waits while a scripted turn runs the conversation in-process, then serves it', async () => {
    const session = await isolatedSession();
    const taken = await takeConversation(session.id, 'turn');
    if (!('hold' in taken)) throw new Error('the conversation was already held');
    const worker = startWorker(session.id);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    expect(await readWorkerRecord(session.id), 'a worker started in the middle of a turn').toBeUndefined();
    expect(worker.exitCode).toBeNull();
    await taken.hold.release();
    await until(() => serving(session.id), 'the worker to serve once the turn ended');
    expect((await readWorkerRecord(session.id))?.pid).toBe(worker.pid);
  });
});

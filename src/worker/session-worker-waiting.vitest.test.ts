/** What a session worker waits for: background shells the agent started, a
 * turn already running, an approval nobody has answered yet.
 *
 * Real spawned workers on real sockets, running ClikCode's own agent against
 * a real HTTP server that speaks the Gateway's turn protocol -- the model is
 * the only thing standing in. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
import type { TerminalHarnessPrompter } from '../tui/prompter.js';
import { closeAllWorkerClients, followWorkerTurn, questionOrWorker, runTurnThroughWorker, workerQueueMark, workerRunningTurn } from './turn-bridge.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = join(repoRoot, 'dist', 'index.js');
const ENV_KEYS = ['CLIKCODE_HOME', 'CLIKCODE_WORKER_ENTRY', 'XDG_CONFIG_HOME', 'CLIKCODE_GATEWAY_URL_OVERRIDE', 'CLIKCODE_WORKER_IDLE_EXIT_MS'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let root: string | undefined;
let gateway: FakeGateway | undefined;
const clients: WorkerClient[] = [];
const workerPids: number[] = [];

beforeAll(async () => {
  process.env.CLIKCODE_WORKER_ENTRY = distEntry;
  if (!await access(distEntry).then(() => true, () => false)) await promisify(execFile)('node', ['scripts/build.mjs'], { cwd: repoRoot });
}, 30_000);

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterEach(async () => {
  await closeAllWorkerClients();
  for (const client of clients.splice(0)) client.close();
  for (const pid of workerPids.splice(0)) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  await gateway?.close();
  gateway = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

interface TurnRequest { items: { type: string; role?: string; text?: string; name?: string }[]; respond: (frames: Record<string, unknown>[]) => void }

/** The Gateway's turn endpoint, one scripted answer per request, or held
 * until the test answers. Everything else it serves is a 404. */
class FakeGateway {
  readonly requests: TurnRequest[] = [];
  private waiters: ((request: TurnRequest) => void)[] = [];
  private unclaimed: TurnRequest[] = [];
  /** Set: every request is answered with this at once, instead of waiting. */
  autoAnswer: Record<string, unknown>[] | undefined;
  private constructor(private readonly server: Server, readonly url: string) {}

  static async start(): Promise<FakeGateway> {
    let self!: FakeGateway;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url?.startsWith('/api/clikcode/v1/turn')) { res.writeHead(404).end('{}'); return; }
        const body = JSON.parse(raw) as { items: TurnRequest['items'] };
        const request: TurnRequest = {
          items: body.items,
          respond: (frames) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
            res.end();
          },
        };
        self.requests.push(request);
        if (self.autoAnswer) { request.respond(self.autoAnswer); return; }
        const waiter = self.waiters.shift();
        if (waiter) waiter(request); else self.unclaimed.push(request);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    self = new FakeGateway(server, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    return self;
  }

  next(timeoutMs = 20_000): Promise<TurnRequest> {
    const ready = this.unclaimed.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a model request')), timeoutMs);
      this.waiters.push((request) => { clearTimeout(timer); resolve(request); });
    });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

const text = (value: string): Record<string, unknown>[] => [{ type: 'text-delta', text: value }, { type: 'finish', stopReason: 'stop' }];
const call = (name: string, args: Record<string, unknown>): Record<string, unknown>[] => [{ type: 'tool-call', id: `c-${randomUUID()}`, name, args }, { type: 'finish', stopReason: 'tool-calls' }];

async function gatewaySession(permissionMode: HarnessSession['permissionMode'] = 'bypass', idleExitMs?: number): Promise<HarnessSession & { workspace: string }> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-worker-wait-'));
  process.env.CLIKCODE_HOME = join(root, 'home');
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  gateway = await FakeGateway.start();
  process.env.CLIKCODE_GATEWAY_URL_OVERRIDE = gateway.url;
  if (idleExitMs) process.env.CLIKCODE_WORKER_IDLE_EXIT_MS = String(idleExitMs);
  else delete process.env.CLIKCODE_WORKER_IDLE_EXIT_MS;
  await mkdir(join(root, 'config', 'clikcode'), { recursive: true });
  await writeFile(join(root, 'config', 'clikcode', 'auth.json'), JSON.stringify({ apiUrl: gateway.url, apiKey: 'test-key' }));
  const workspace = join(root, 'work');
  await mkdir(workspace, { recursive: true });
  const state = await readState();
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(), conversationId: randomUUID(), route: 'gateway', accountId: null, provider: 'gateway', model: null,
    effort: 'platform-managed', permissionMode, accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
    workspace, title: 'test conversation', gatewayConfirmed: true,
  } as HarnessSession & { workspace: string };
  state.sessions.push(session);
  await writeState(state);
  return session;
}

async function attach(sessionId: string): Promise<WorkerClient> {
  const client = await WorkerClient.attach(sessionId);
  clients.push(client);
  const record = await readWorkerRecord(sessionId);
  if (record && !workerPids.includes(record.pid)) workerPids.push(record.pid);
  return client;
}

/** Every event from now until (and including) the first of `type`. */
function eventsUntil(client: WorkerClient, type: WorkerEvent['type'], timeoutMs = 20_000): Promise<WorkerEvent[]> {
  const seen: WorkerEvent[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('event', onEvent); reject(new Error(`timed out waiting for "${type}"; saw ${seen.map((event) => event.type).join(', ')}`)); }, timeoutMs);
    const onEvent = (event: WorkerEvent): void => {
      seen.push(event);
      if (event.type !== type) return;
      clearTimeout(timer);
      client.off('event', onEvent);
      resolve(seen);
    };
    client.on('event', onEvent);
  });
}

async function processExit(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); } catch { return; }
    if (Date.now() > deadline) throw new Error(`process ${pid} is still running`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function storedSession(id: string): Promise<HarnessSession> {
  return (await readState()).sessions.find((item) => item.id === id)!;
}

/** A background command that finishes when the test says so. */
const gatedCommand = (gate: string, then: string): string => `while [ ! -e ${JSON.stringify(gate)} ]; do sleep 0.05; done; ${then}`;

describe('a session worker waits for what it should', () => {
  it('runs a follow-up turn, followed by the attached window, when a background shell finishes after the turn', async () => {
    const session = await gatewaySession();
    const gate = join(session.workspace, 'gate');
    const client = await attach(session.id);
    const firstTurn = eventsUntil(client, 'waiting-stop');
    client.send({ type: 'submit', text: 'build it in the background', echo: true });
    (await gateway!.next()).respond(call('bash', { command: gatedCommand(gate, 'echo build-finished'), run_in_background: true }));
    const second = await gateway!.next();
    expect(JSON.stringify(second.items.at(-1))).toContain('You will be told when it exits');
    second.respond(text('Started; I will hear when it is done.'));
    await firstTurn;

    const followUp = eventsUntil(client, 'waiting-stop');
    await writeFile(gate, '');
    const told = await gateway!.next();
    const notice = told.items.find((item) => item.type === 'text' && item.role === 'user' && item.text?.startsWith('[background shell bash_1 exited (code 0)]'));
    expect(notice?.text).toContain('build-finished');
    told.respond(text('The build finished.'));
    const events = await followUp;
    expect(events.find((event) => event.type === 'waiting-start')).toMatchObject({ prompt: expect.stringMatching(/^\[background shell bash_1 exited \(code 0\)\]/) });
    expect(events.filter((event) => event.type === 'delta').map((event) => (event as { text: string }).text).join('')).toContain('The build finished.');

    const saved = await storedSession(session.id);
    expect(saved.queuedTurns ?? []).toEqual([]);
    expect(JSON.stringify(saved.messages)).toContain('The build finished.');
    expect(JSON.stringify(saved.messages)).toContain('[background shell bash_1 exited (code 0)]');
  }, 60_000);

  it('runs that follow-up turn with no window attached, and does not idle-exit while the shell runs', async () => {
    // Idle exit after 300 ms, and a shell that runs far longer than that.
    const session = await gatewaySession('bypass', 300);
    const gate = join(session.workspace, 'gate');
    const client = await attach(session.id);
    const pid = workerPids[0]!;
    const firstTurn = eventsUntil(client, 'waiting-stop');
    client.send({ type: 'submit', text: 'start the job', echo: true });
    (await gateway!.next()).respond(call('bash', { command: gatedCommand(gate, 'echo job-done'), run_in_background: true }));
    (await gateway!.next()).respond(text('Started.'));
    await firstTurn;
    client.close();
    clients.splice(0);

    // Nobody attached and the idle limit long past: the worker is still
    // there, because the shell's exit is still owed to the model.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await writeFile(gate, '');
    const told = await gateway!.next();
    expect(JSON.stringify(told.items)).toContain('job-done');
    told.respond(text('Job done.'));
    // Then, with nothing left owed, it exits on its own.
    await processExit(pid);
    expect(JSON.stringify((await storedSession(session.id)).messages)).toContain('Job done.');
  }, 60_000);

  it('records a shell it stops on shutdown as a queued notification for the next worker', async () => {
    const session = await gatewaySession();
    const client = await attach(session.id);
    const pid = workerPids[0]!;
    const firstTurn = eventsUntil(client, 'waiting-stop');
    client.send({ type: 'submit', text: 'serve it', echo: true });
    (await gateway!.next()).respond(call('bash', { command: 'sleep 300', run_in_background: true }));
    (await gateway!.next()).respond(text('Serving.'));
    await firstTurn;
    process.kill(pid, 'SIGTERM');
    await processExit(pid);
    const queued = (await storedSession(session.id)).queuedTurns ?? [];
    expect(queued).toEqual([expect.objectContaining({ kind: 'notification', text: expect.stringMatching(/^\[background shell bash_1 was stopped: ClikCode's worker for this conversation stopped \(SIGTERM\)\] sleep 300/) })]);
  }, 60_000);

  it('queues a submit that arrives while a turn runs instead of starting a second turn', async () => {
    const session = await gatewaySession();
    const client = await attach(session.id);
    const firstTurn = eventsUntil(client, 'waiting-stop');
    client.send({ type: 'submit', text: 'first', echo: true });
    const held = await gateway!.next();
    const queuedAnswer = eventsUntil(client, 'submit-queued');
    client.send({ type: 'submit', text: 'second', echo: true });
    const answered = (await queuedAnswer).at(-1) as Extract<WorkerEvent, { type: 'submit-queued' }>;
    expect((await storedSession(session.id)).queuedTurns).toEqual([expect.objectContaining({ id: answered.queuedTurnId, text: 'second' })]);
    held.respond(text('one'));
    const events = await firstTurn;
    expect(events.filter((event) => event.type === 'waiting-start')).toHaveLength(1);
    expect(gateway!.requests).toHaveLength(1);

    // The window sends the queued message as it always has; a second window
    // sending the same entry while it runs follows it rather than rerunning it.
    const other = await attach(session.id);
    const secondTurn = eventsUntil(client, 'waiting-stop');
    client.send({ type: 'submit', text: 'second', echo: true, queuedTurnId: answered.queuedTurnId });
    const secondRequest = await gateway!.next();
    const followed = eventsUntil(other, 'snapshot');
    other.send({ type: 'submit', text: 'second', echo: true, queuedTurnId: answered.queuedTurnId });
    expect((await followed).at(-1)).toMatchObject({ live: { prompt: 'second' } });
    secondRequest.respond(text('two'));
    await secondTurn;
    // Once it has run, sending it again is answered as done, not run again.
    const again = eventsUntil(other, 'waiting-stop');
    other.send({ type: 'submit', text: 'second', echo: true, queuedTurnId: answered.queuedTurnId });
    await again;
    expect(gateway!.requests).toHaveLength(2);
  }, 60_000);

  it('asks a window that attaches later for an approval the turn is still waiting on', async () => {
    const session = await gatewaySession('ask');
    const first = await attach(session.id);
    const asked = eventsUntil(first, 'approval-request');
    first.send({ type: 'submit', text: 'write the file', echo: true });
    (await gateway!.next()).respond(call('write_file', { path: 'out.txt', content: 'hello' }));
    await asked;
    // The window that was asked goes away without answering.
    first.close();
    clients.splice(clients.indexOf(first), 1);

    const second = await WorkerClient.attach(session.id);
    clients.push(second);
    const reasked = (await eventsUntil(second, 'approval-request')).at(-1) as Extract<WorkerEvent, { type: 'approval-request' }>;
    expect(reasked.title).toMatch(/out\.txt/);
    const done = eventsUntil(second, 'waiting-stop');
    second.send({ type: 'approval-response', id: reasked.id, approved: true });
    (await gateway!.next()).respond(text('Written.'));
    await done;
    await expect(access(join(session.workspace, 'out.txt'))).resolves.toBeUndefined();
  }, 60_000);
});

/** A window's prompt that waits for a key that never comes, until the bridge interrupts it. */
const idlePrompt = (signal?: AbortSignal): Promise<string> => new Promise((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(Object.assign(new Error('interrupted'), { code: 'ERR_PROMPT_INTERRUPTED' })), { once: true });
});

function recordingPrompter(): TerminalHarnessPrompter & { calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push(`${name}(${args.map((arg) => (typeof arg === 'function' ? '[fn]' : JSON.stringify(arg))).join(',')})`); };
  return {
    calls, render: record('render'), response: record('response'), activity: record('activity'), activityEvent: record('activityEvent'),
    phase: record('phase'), setPlan: record('setPlan'), setTurnUsage: record('setTurnUsage'), startWaiting: record('startWaiting'), stopWaiting: record('stopWaiting'),
    approval: async (...args: unknown[]) => { record('approval')(...args); return true; },
    suspend: async () => undefined, resume: record('resume'), restoreDraft: record('restoreDraft'), submitted: record('submitted'),
  } as unknown as TerminalHarnessPrompter & { calls: string[] };
}

describe('a window at its prompt', () => {
  it('reopening a conversation mid-turn follows the running turn to its end', async () => {
    const session = await gatewaySession();
    const other = await attach(session.id);
    other.send({ type: 'submit', text: 'long question', echo: true });
    const held = await gateway!.next();
    // This window arrives while the turn runs: it does not sit at its prompt.
    const woke = await questionOrWorker(session.id, idlePrompt);
    expect(woke).toEqual({ woke: 'turn', prompt: 'long question' });
    const rl = recordingPrompter();
    const followed = followWorkerTurn(session.id, rl);
    held.respond(text('the long answer'));
    await followed;
    expect(rl.calls.some((entry) => entry.startsWith('startWaiting("thinking"'))).toBe(true);
    expect(rl.calls.filter((entry) => entry.startsWith('response(')).join('')).toContain('the long answer');
    expect(rl.calls.at(-1)).toBe('stopWaiting()');
  }, 60_000);

  it('is interrupted by a turn the worker starts itself, and by a change to the queue', async () => {
    const session = await gatewaySession();
    const other = await attach(session.id);
    // Idle window: the typed-as-the-turn-ended race queues a message.
    const queued = questionOrWorker(session.id, idlePrompt);
    other.send({ type: 'steer', text: 'queued while idle', id: 'late-1' });
    expect(await queued).toEqual({ woke: 'queue' });

    // And a turn started by someone else wakes it with that turn's prompt.
    const turn = questionOrWorker(session.id, idlePrompt);
    other.send({ type: 'submit', text: 'from another window', echo: true });
    expect(await turn).toEqual({ woke: 'turn', prompt: 'from another window' });
    const rl = recordingPrompter();
    const followed = followWorkerTurn(session.id, rl);
    (await gateway!.next()).respond(text('answered'));
    await followed;
    expect(rl.calls.filter((entry) => entry.startsWith('response(')).join('')).toContain('answered');
  }, 60_000);

  it('does not miss a queue change that landed before its prompt opened', async () => {
    const session = await gatewaySession();
    const other = await attach(session.id);
    // A first prompt attaches this window's own connection.
    await questionOrWorker(session.id, async () => 'typed');
    const mark = workerQueueMark(session.id);
    const answered = new Promise<void>((resolve) => other.once('event', () => resolve()));
    other.send({ type: 'steer', text: 'queued before the prompt', id: 'late-2' });
    await answered;
    // Wait until this window's connection has seen it too, then open the prompt.
    const deadline = Date.now() + 10_000;
    while (workerQueueMark(session.id) === mark && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(questionOrWorker(session.id, idlePrompt, mark)).resolves.toEqual({ woke: 'queue' });
  }, 60_000);

  it('answers a key normally when nothing happens', async () => {
    const session = await gatewaySession();
    await attach(session.id);
    await expect(questionOrWorker(session.id, async () => 'typed')).resolves.toEqual({ line: 'typed' });
  }, 60_000);
});

describe('a message sent while another window\'s turn runs', () => {
  it('is queued once, the running turn is shown to its end, and the message runs after it', async () => {
    const session = await gatewaySession();
    const other = await attach(session.id);
    let queueChanges = 0;
    other.on('event', (event: WorkerEvent) => { if (event.type === 'queue-changed') queueChanges++; });
    other.send({ type: 'submit', text: 'the other window asks', echo: true });
    const held = await gateway!.next();
    // This window had no worker connection when its prompt opened: it sends
    // its message straight into the running turn.
    const rl = recordingPrompter();
    let finished = false;
    const sent = runTurnThroughWorker(session.id, rl, 'my message', { echo: true }).finally(() => { finished = true; });
    const deadline = Date.now() + 10_000;
    while (!(await storedSession(session.id)).queuedTurns?.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const queued = (await storedSession(session.id)).queuedTurns ?? [];
    expect(queued).toEqual([expect.objectContaining({ text: 'my message' })]);
    // It stays on the running turn instead of handing the loop the queued
    // message to send again (and again) while that turn runs.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(finished).toBe(false);
    expect(queueChanges).toBe(1);
    expect(workerRunningTurn(session.id)).toEqual({ prompt: 'the other window asks' });
    held.respond(text('the other answer'));
    expect(await sent).toEqual({ notice: 'Queued behind the turn already running' });
    expect(rl.calls).toContain('submitted("the other window asks")');
    expect(rl.calls.filter((entry) => entry.startsWith('response(')).join('')).toContain('the other answer');
    expect(workerRunningTurn(session.id)).toBeUndefined();

    // The loop then sends the queued message, once, and it runs.
    const mine = runTurnThroughWorker(session.id, recordingPrompter(), 'my message', { echo: true, queuedTurnId: queued[0]!.id });
    const request = await gateway!.next();
    expect(JSON.stringify(request.items)).toContain('my message');
    request.respond(text('my answer'));
    await mine;
    expect(gateway!.requests).toHaveLength(2);
    const saved = await storedSession(session.id);
    expect(saved.queuedTurns ?? []).toEqual([]);
    expect(JSON.stringify(saved.messages)).toContain('my answer');
  }, 60_000);
});

describe('a message typed as the turn ends', () => {
  it('is answered, stored and announced before the turn says it is over, whenever it lands', async () => {
    const session = await gatewaySession();
    const client = await attach(session.id);
    let lost = 0;
    for (let round = 0; round < 24; round++) {
      const events = eventsUntil(client, 'waiting-stop');
      client.send({ type: 'submit', text: `question ${round}`, echo: true });
      const held = await gateway!.next();
      const id = `late-${round}`;
      held.respond(text(`answer ${round}`));
      await new Promise((resolve) => setTimeout(resolve, round));
      // A message steered in gets one more model step.
      gateway!.autoAnswer = text(`after steer ${round}`);
      client.send({ type: 'steer', text: `typed ${round}`, id });
      const seen = await events;
      gateway!.autoAnswer = undefined;
      const answer = seen.find((event) => event.type === 'submission' && event.id === id) as Extract<WorkerEvent, { type: 'submission' }> | undefined;
      const stored = (await storedSession(session.id)).queuedTurns ?? [];
      if (!answer) {
        // Only acceptable when the turn had already ended: then it is queued
        // durably and announced, after the waiting-stop.
        const late = (await eventsUntil(client, 'queue-changed', 10_000)).length;
        expect(late).toBeGreaterThan(0);
        expect((await storedSession(session.id)).queuedTurns).toEqual([expect.objectContaining({ id })]);
      } else if (answer.disposition === 'queued') {
        // The last word the window gets on this turn already has it queued.
        const finalSnapshot = seen.filter((event) => event.type === 'snapshot').at(-1) as Extract<WorkerEvent, { type: 'snapshot' }>;
        if (!finalSnapshot.session.queuedTurns?.some((item) => item.id === id)) lost++;
        expect(stored).toEqual([expect.objectContaining({ id })]);
      } else {
        expect(answer.disposition).toBe('steered');
      }
      // The next round starts from an empty queue (the worker leaves a typed
      // message for the window to send).
      const state = await readState();
      const found = state.sessions.find((item) => item.id === session.id)!;
      delete found.queuedTurns;
      await writeState(state);
    }
    expect(lost).toBe(0);
  }, 120_000);
});

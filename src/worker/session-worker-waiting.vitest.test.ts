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
import { listWorkerRecords, readWorkerRecord, writeWorkerRecord } from './registry.js';
import type { WorkerEvent } from './protocol.js';
import type { TerminalHarnessPrompter } from '../tui/prompter.js';
import { closeAllWorkerClients, followWorkerTurn, questionOrWorker, runTurnThroughWorker, workerQueueMark, workerTurn } from './turn-bridge.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = join(repoRoot, 'dist', 'index.js');
const ENV_KEYS = ['CLIKCODE_HOME', 'CLIKCODE_WORKER_ENTRY', 'XDG_CONFIG_HOME', 'CLIKCODE_GATEWAY_URL_OVERRIDE', 'CLIKCODE_WORKER_IDLE_EXIT_MS', 'CLIKCODE_WORKER_BUILD_WATCH_MS'] as const;
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
  // Waited out before the directory goes: a worker shutting down still
  // writes there (its record, the conversation's state), and removing the
  // tree under it failed with ENOTEMPTY whenever the machine was slow.
  // Every worker this test's home has, not only those attach() noted: the
  // turn bridge spawns its own.
  const recorded = root ? (await listWorkerRecords().catch(() => [])).map((record) => record.pid) : [];
  const stopping = [...new Set([...workerPids.splice(0), ...recorded])];
  for (const pid of stopping) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  await Promise.all(stopping.map((pid) => processExit(pid)));
  await gateway?.close();
  gateway = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

interface TurnRequest {
  items: { type: string; role?: string; text?: string; name?: string }[];
  respond: (frames: Record<string, unknown>[]) => void;
  /** The same, one frame every `everyMs`: a model still writing. */
  respondSlowly: (frames: Record<string, unknown>[], everyMs: number) => Promise<void>;
}

/** The Gateway's OpenAI-compatible endpoint, one scripted answer per request, or held
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
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end('{}'); return; }
        const body = JSON.parse(raw) as { messages: Array<{ role: string; content?: string | null | Array<{ type: string; text?: string }> }> };
        const request: TurnRequest = {
          items: body.messages.map((message) => ({
            type: 'text', role: message.role,
            text: typeof message.content === 'string' ? message.content
              : Array.isArray(message.content)
                ? message.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n\n')
                : '',
          })),
          respond: (frames) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
            res.end();
          },
          respondSlowly: async (frames, everyMs) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const frame of frames) {
              res.write(`data: ${JSON.stringify(frame)}\n\n`);
              await new Promise((resolve) => setTimeout(resolve, everyMs));
            }
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

const text = (value: string): Record<string, unknown>[] => [
  { choices: [{ index: 0, delta: { content: value }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
];
/** One answer, streamed a word at a time. */
const words = (value: string): Record<string, unknown>[] => [
  ...(value.match(/\S+\s*/g) ?? []).map((piece) => ({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })),
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
];
const call = (name: string, args: Record<string, unknown>): Record<string, unknown>[] => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c-${randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
];

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
    workspace, title: 'test conversation', nameSource: 'user', gatewayConfirmed: true,
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

  it('idle-exits on time while its build check keeps running', async () => {
    // A build check far more often than the idle limit: the check must not
    // restart the idle timer, or the worker would never leave.
    process.env.CLIKCODE_WORKER_BUILD_WATCH_MS = '100';
    const session = await gatewaySession('bypass', 1_000);
    const client = await attach(session.id);
    const pid = workerPids[0]!;
    client.close();
    clients.splice(0);
    await processExit(pid, 8_000);
  }, 30_000);

  it('writes its lifecycle -- attach, turn start and end, idle state -- to the lifecycle log', async () => {
    process.env.CLIKCODE_LIFECYCLE_LOG = '1';
    try {
      const session = await gatewaySession();
      const client = await attach(session.id);
      const done = eventsUntil(client, 'waiting-stop');
      client.send({ type: 'submit', text: 'say hi', echo: true });
      (await gateway!.next()).respond(text('hi'));
      await done;
      const logPath = join(process.env.CLIKCODE_HOME!, 'logs', 'lifecycle.log');
      const events = async (): Promise<string[]> => (await import('node:fs/promises')).readFile(logPath, 'utf8')
        .then((raw) => raw.trim().split('\n').map((line) => JSON.parse(line) as { event: string; role: string; session?: string })
          .filter((entry) => entry.role === 'worker' && entry.session === session.id).map((entry) => entry.event), () => []);
      for (let tries = 0; tries < 100 && !(await events()).includes('worker.turn.end'); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      const seen = await events();
      for (const event of ['process.start', 'worker.client.attach', 'worker.turn.start', 'worker.turn.end', 'worker.idle']) expect(seen).toContain(event);
      expect(seen.indexOf('worker.turn.start')).toBeLessThan(seen.indexOf('worker.turn.end'));
    } finally { delete process.env.CLIKCODE_LIFECYCLE_LOG; }
  }, 60_000);

  it('idle-exits even when its home was deleted under it (a test run ending)', async () => {
    const session = await gatewaySession('bypass', 1_000);
    const client = await attach(session.id);
    const pid = workerPids[0]!;
    client.close();
    clients.splice(0);
    await rm(process.env.CLIKCODE_HOME!, { recursive: true, force: true });
    await processExit(pid, 10_000);
  }, 30_000);

  it('leaves when its home is deleted while a turn waits on an approval nobody can answer', async () => {
    process.env.CLIKCODE_WORKER_BUILD_WATCH_MS = '100';
    const session = await gatewaySession('ask');
    const client = await attach(session.id);
    const pid = workerPids[0]!;
    const asked = eventsUntil(client, 'approval-request');
    client.send({ type: 'submit', text: 'write it', echo: true });
    (await gateway!.next()).respond(call('bash', { command: 'touch made-by-test' }));
    await asked;
    client.close();
    clients.splice(0);
    await rm(process.env.CLIKCODE_HOME!, { recursive: true, force: true });
    await processExit(pid, 10_000);
  }, 30_000);

  it('idle-exits when its window vanished without saying goodbye', async () => {
    const session = await gatewaySession('bypass', 1_000);
    const client = await attach(session.id);
    const pid = workerPids[0]!;
    (client as unknown as { socket: import('node:net').Socket }).socket.destroy();
    clients.splice(0);
    await processExit(pid, 10_000);
  }, 30_000);

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

  it('shows every window, at once, a message another window typed into the running turn', async () => {
    // The computer started the turn; the phone opened the conversation and
    // typed into it. The computer used to learn of it only when the turn ended.
    const session = await gatewaySession();
    const computer = await attach(session.id);
    const turn = eventsUntil(computer, 'waiting-stop');
    computer.send({ type: 'submit', text: 'long job', echo: true });
    const held = await gateway!.next();
    const phone = await attach(session.id);
    await phone.initialSnapshot;
    const shown = new Promise<WorkerEvent>((resolve) => {
      const onEvent = (event: WorkerEvent): void => {
        const holds = (texts?: readonly { text: string }[]): boolean => Boolean(texts?.some((item) => item.text === 'from the phone'));
        if (event.type === 'snapshot' && (holds(event.session.pendingTurn?.steers) || holds(event.session.queuedTurns))) {
          computer.off('event', onEvent);
          resolve(event);
        }
      };
      computer.on('event', onEvent);
    });
    phone.send({ type: 'steer', text: 'from the phone', id: 'p1' });
    expect(await shown).toMatchObject({ type: 'snapshot', live: { prompt: 'long job' } });
    gateway!.autoAnswer = text('done');
    held.respond(text('done'));
    await turn;
  }, 60_000);

  it('lets a window on a newer build open a conversation mid-turn without stopping the turn', async () => {
    // Two shells: one started the turn, the other runs a newer build of
    // ClikCode and opens the same conversation. The newer one used to decide
    // from the state file whether a turn was running and SIGTERM the worker
    // when the file said no -- "session worker exited mid-turn: SIGTERM".
    const session = await gatewaySession();
    const first = await attach(session.id);
    const turn = eventsUntil(first, 'waiting-stop');
    first.send({ type: 'submit', text: 'long job', echo: true });
    const held = await gateway!.next();
    const before = (await readWorkerRecord(session.id))!;
    // The file behind the worker: it says nothing is running.
    const state = await readState();
    delete state.sessions.find((item) => item.id === session.id)!.pendingTurn;
    await writeState(state);
    await writeWorkerRecord({ ...before, build: 'a-different-build' });

    await attach(session.id);
    expect((await readWorkerRecord(session.id))?.pid).toBe(before.pid);

    held.respond(text('done'));
    const events = await turn;
    expect(events.filter((event) => event.type === 'turn-error')).toEqual([]);
    // Asked to step down while busy, it goes once the turn is over.
    await processExit(before.pid);
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
    phase: record('phase'), setPlan: record('setPlan'), setTurnUsage: record('setTurnUsage'), startWaiting: record('startWaiting'), turnStarting: record('turnStarting'), stopWaiting: record('stopWaiting'),
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
    // This window's own connection first, and the queue as it read it: a
    // steer sent while that connection was still being made was reported to
    // nobody, and the prompt waited for it forever (seen under load).
    await questionOrWorker(session.id, async () => 'typed');
    const mark = workerQueueMark(session.id);
    // Idle window: the typed-as-the-turn-ended race queues a message.
    const queued = questionOrWorker(session.id, idlePrompt, mark);
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
    expect(await workerTurn(session.id)).toEqual({ prompt: 'the other window asks' });
    held.respond(text('the other answer'));
    expect(await sent).toEqual({ notice: 'Queued behind the turn already running' });
    expect(rl.calls).toContain('submitted("the other window asks")');
    expect(rl.calls.filter((entry) => entry.startsWith('response(')).join('')).toContain('the other answer');
    expect(await workerTurn(session.id)).toBeUndefined();

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
      const all: WorkerEvent[] = [];
      const record = (event: WorkerEvent): void => { all.push(event); };
      client.on('event', record);
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
        const deadline = Date.now() + 10_000;
        const announced = (): boolean => {
          const at = all.findIndex((event) => event.type === 'submission' && event.id === id);
          return at >= 0 && all.slice(at).some((event) => event.type === 'queue-changed');
        };
        while (!announced() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        expect(announced()).toBe(true);
        expect((await storedSession(session.id)).queuedTurns).toEqual([expect.objectContaining({ id })]);
      } else if (answer.disposition === 'queued') {
        // The last word the window gets on this turn already has it queued.
        const finalSnapshot = seen.filter((event) => event.type === 'snapshot').at(-1) as Extract<WorkerEvent, { type: 'snapshot' }>;
        if (!finalSnapshot.session.queuedTurns?.some((item) => item.id === id)) lost++;
        expect(stored).toEqual([expect.objectContaining({ id })]);
      } else {
        expect(answer.disposition).toBe('steered');
      }
      client.off('event', record);
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

describe('a window joining a running turn', () => {
  it('is sent every streamed word exactly once, and the tool rows and plan so far', async () => {
    const session = await gatewaySession();
    const starter = await attach(session.id);
    const done = eventsUntil(starter, 'waiting-stop');
    starter.send({ type: 'submit', text: 'look, then explain', echo: true });
    (await gateway!.next()).respond(call('bash', { command: 'echo looked' }));
    const answer = Array.from({ length: 120 }, (_, index) => `word${index}`).join(' ');
    const streaming = (await gateway!.next()).respondSlowly(words(answer), 4);
    // Windows join all through the answer. Each attach reads the conversation
    // while words keep streaming: a window joined to the broadcast before that
    // read was sent those words twice, once as deltas and once in the snapshot.
    const joined: Array<{ client: WorkerClient; events: Promise<WorkerEvent[]> }> = [];
    for (let index = 0; index < 6; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const client = await WorkerClient.attach(session.id);
      clients.push(client);
      joined.push({ client, events: eventsUntil(client, 'waiting-stop') });
    }
    await streaming;
    await done;
    for (const { client, events } of joined) {
      const initial = client.initialEvent;
      expect(initial?.type).toBe('snapshot');
      const live = initial?.type === 'snapshot' ? initial.live : undefined;
      if (!live) continue; // joined after the turn ended
      let shown = live.text;
      for (const event of await events) if (event.type === 'delta') shown = event.mode === 'replace' ? event.text : shown + event.text;
      expect(shown.trim()).toBe(answer);
      // The call made before the answer, with where in it it happened.
      expect(live.activities?.map((item) => item.event.kind)).toEqual(expect.arrayContaining(['tool-start']));
      expect(live.activities?.every((item) => item.responseOffset === 0)).toBe(true);
    }
    expect(joined.filter(({ client }) => client.initialEvent?.type === 'snapshot' && client.initialEvent.live).length).toBeGreaterThan(2);
  }, 60_000);
});

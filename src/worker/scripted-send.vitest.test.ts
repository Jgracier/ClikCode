/** A scripted send reaches the conversation through its worker when one is
 * running, and holds the conversation when it runs the turn itself.
 *
 * Real spawned workers on real sockets, running ClikCode's own agent against
 * a local HTTP server that speaks the Gateway's chat protocol. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Conf from 'conf';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import { WorkerClient } from './client.js';
import { conversationHolder, readWorkerRecord } from './registry.js';
import type { WorkerEvent } from './protocol.js';
import { sendScriptedTurn } from './scripted-send.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = join(repoRoot, 'dist', 'index.js');
const ENV_KEYS = ['HOME', 'CLIKCODE_HOME', 'CLIKCODE_WORKER_ENTRY', 'XDG_CONFIG_HOME', 'CLIKCODE_GATEWAY_URL_OVERRIDE'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let root: string | undefined;
let server: Server | undefined;
const clients: WorkerClient[] = [];
const workerPids: number[] = [];
/** Model requests in arrival order: the last user message, and how to answer. */
const requests: { prompt: string; answer: (text: string) => void }[] = [];
const arrived: (() => void)[] = [];

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
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.close();
  for (const pid of workerPids.splice(0)) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  server?.closeAllConnections();
  await new Promise((resolveClose) => (server ? server.close(resolveClose) : resolveClose(undefined)));
  server = undefined;
  requests.splice(0);
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function answer(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.end();
}

/** The request after `count` have arrived. */
async function request(count: number, timeoutMs = 20_000): Promise<(typeof requests)[number]> {
  const deadline = Date.now() + timeoutMs;
  while (requests.length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for model request ${count}`);
    await new Promise<void>((resolveWait) => { arrived.push(resolveWait); setTimeout(resolveWait, 50); });
  }
  return requests[count - 1]!;
}

async function gatewaySession(): Promise<HarnessSession> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-scripted-send-'));
  process.env.HOME = join(root, 'user');
  process.env.CLIKCODE_HOME = join(root, 'home');
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end('{}'); return; }
      const body = JSON.parse(raw) as { messages: { role: string; content?: unknown }[] };
      const last = body.messages.filter((message) => message.role === 'user').at(-1);
      requests.push({ prompt: JSON.stringify(last?.content ?? ''), answer: (text) => answer(res, text) });
      for (const wake of arrived.splice(0)) wake();
    });
  });
  await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.CLIKCODE_GATEWAY_URL_OVERRIDE = url;
  await mkdir(join(root, 'user'), { recursive: true });
  await mkdir(join(root, 'config', 'clikcode'), { recursive: true });
  await writeFile(join(root, 'config', 'clikcode', 'auth.json'), JSON.stringify({ apiUrl: url, apiKey: 'test-key' }));
  const workspace = join(root, 'work');
  await mkdir(workspace, { recursive: true });
  const state = await readState();
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(), conversationId: randomUUID(), route: 'gateway', accountId: null, provider: 'gateway', model: null,
    effort: 'platform-managed', permissionMode: 'bypass', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
    workspace, title: 'test conversation', gatewayConfirmed: true,
  } as HarnessSession;
  state.sessions.push(session);
  await writeState(state);
  return session;
}

const config = (): Conf => new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
const stored = async (id: string): Promise<HarnessSession> => (await readState()).sessions.find((item) => item.id === id)!;

describe('a scripted send', () => {
  it('goes through a running worker, queued behind the turn a window is running', async () => {
    const session = await gatewaySession();
    const window = await WorkerClient.attach(session.id);
    clients.push(window);
    workerPids.push((await readWorkerRecord(session.id))!.pid);
    const windowTurnEnded = new Promise<void>((resolveEnd) => {
      window.on('event', (event: WorkerEvent) => { if (event.type === 'waiting-stop') resolveEnd(); });
    });
    window.send({ type: 'submit', text: 'the window asks first', echo: true });
    const first = await request(1);

    const printed: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
    const scripted = sendScriptedTurn(config(), session.id, 'the script asks second');
    // Queued durably, and nothing sent into the running turn.
    for (let tries = 0; !(await stored(session.id)).queuedTurns?.length; tries++) {
      if (tries > 200) throw new Error('the scripted message was never queued');
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    expect((await stored(session.id)).queuedTurns?.map((item) => item.text)).toEqual(['the script asks second']);
    expect(requests).toHaveLength(1);

    first.answer('first answer');
    await windowTurnEnded;
    const second = await request(2);
    expect(second.prompt).toContain('the script asks second');
    second.answer('second answer');
    await scripted;

    const saved = await stored(session.id);
    expect(saved.pendingTurn).toBeUndefined();
    expect(saved.queuedTurns ?? []).toEqual([]);
    expect(saved.messages?.map((message) => message.content)).toEqual([
      'the window asks first', 'first answer', 'the script asks second', 'second answer',
    ]);
    expect(printed.join('')).toContain('second answer');
  }, 60_000);

  it('with no worker, runs here holding the conversation, so a worker cannot start mid-turn', async () => {
    const session = await gatewaySession();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const scripted = sendScriptedTurn(config(), session.id, 'nobody else is here');
    const asked = await request(1);
    expect(await conversationHolder(session.id)).toMatchObject({ kind: 'turn', pid: process.pid });
    asked.answer('done here');
    await scripted;
    expect(await conversationHolder(session.id)).toBeUndefined();
    expect(await readWorkerRecord(session.id)).toBeUndefined();
    expect((await stored(session.id)).messages?.map((message) => message.content)).toEqual(['nobody else is here', 'done here']);
  }, 60_000);
});

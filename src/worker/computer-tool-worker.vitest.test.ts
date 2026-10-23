/** The shared computer tools against a real spawned worker, through the real MCP
 * server and CLI client: a harness gets typed tools, the window answers the
 * private prompt and the approval, and no secret value comes back. Uses dist/index.js. */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import { lockCredentialVault, readNamedSecret, saveNamedSecret } from '../agent/computer/credential-vault.js';
import { WorkerClient } from './client.js';
import { listWorkerRecords } from './registry.js';
import type { WorkerEvent } from './protocol.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = join(repoRoot, 'dist', 'index.js');
const ENV_KEYS = ['CLIKCODE_HOME', 'CLIKCODE_WORKER_ENTRY', 'XDG_CONFIG_HOME', 'CLIKCODE_GATEWAY_URL_OVERRIDE', 'PATH'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
let root: string | undefined;
const clients: WorkerClient[] = [];
const children: ReturnType<typeof spawn>[] = [];
const VALUE = 'salad_live_9f8e7d6c5b4a39281706';

beforeAll(async () => {
  process.env.CLIKCODE_WORKER_ENTRY = distEntry;
  await promisify(execFile)('node', ['scripts/build.mjs'], { cwd: repoRoot });
}, 60_000);
afterAll(() => { for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } });
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const client of clients.splice(0)) client.close();
  const pids = root ? (await listWorkerRecords().catch(() => [])).map(record => record.pid) : [];
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  for (const pid of pids) for (let wait = 0; wait < 300; wait++) { try { process.kill(pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 50)); }
  if (root) { lockCredentialVault(join(root, 'home')); await rm(root, { recursive: true, force: true }); root = undefined; }
});

async function session(): Promise<{ id: string; home: string }> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-worker-tools-'));
  const home = join(root, 'home');
  process.env.CLIKCODE_HOME = home;
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.CLIKCODE_GATEWAY_URL_OVERRIDE = 'http://127.0.0.1:9';
  await mkdir(join(root, 'config', 'clikcode'), { recursive: true });
  await writeFile(join(root, 'config', 'clikcode', 'auth.json'), JSON.stringify({ apiUrl: 'http://127.0.0.1:9', apiKey: 'test-key' }));
  const workspace = join(root, 'work');
  await mkdir(workspace, { recursive: true });
  const state = await readState();
  const now = new Date().toISOString();
  const id = randomUUID();
  state.sessions.push({ id, conversationId: randomUUID(), route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed',
    permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active', workspace, title: 'tools', nameSource: 'user', gatewayConfirmed: true } as HarnessSession & { workspace: string });
  await writeState(state);
  return { id, home };
}

async function attach(id: string): Promise<WorkerClient> { const client = await WorkerClient.attach(id); clients.push(client); return client; }
function next<T extends WorkerEvent['type']>(client: WorkerClient, type: T, timeoutMs = 20_000): Promise<Extract<WorkerEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('event', onEvent); reject(new Error(`timed out waiting for "${type}"`)); }, timeoutMs);
    const onEvent = (event: WorkerEvent): void => { if (event.type !== type) return; clearTimeout(timer); client.off('event', onEvent); resolve(event as Extract<WorkerEvent, { type: T }>); };
    client.on('event', onEvent);
  });
}

/** The MCP server, spawned the way a harness spawns it: stdio, with the worker named in its environment. */
async function mcpServer(workerId: string): Promise<{ call(method: string, params?: unknown): Promise<any> }> {
  const pid = (await listWorkerRecords()).find(record => record.sessionId === workerId)!.pid;
  const child = spawn(process.execPath, [distEntry, 'mcp-serve'], { env: { ...process.env, CLIKCODE_WORKER_PID: String(pid) }, stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  const waiting = new Map<number, (message: any) => void>();
  createInterface({ input: child.stdout! }).on('line', line => { const message = JSON.parse(line); waiting.get(message.id)?.(message); });
  let counter = 0;
  return { call: (method, params) => new Promise(resolve => { const id = ++counter; waiting.set(id, resolve); child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }) };
}

it('offers the tools over MCP with typed schemas', async () => {
  const { id } = await session();
  await attach(id);
  const server = await mcpServer(id);
  const init = await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  expect(init.result.serverInfo.name).toBe('clikcode');
  const listed = await server.call('tools/list');
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['computer_web', 'computer_desktop', 'clikdeploy_step_up']);
  expect(listed.result.tools[0].inputSchema.additionalProperties).toBe(true);
  expect((await server.call('tools/call', { name: 'nope', arguments: {} })).error.code).toBe(-32602);
}, 60_000);

it('sends a saved secret without asking anyone, and returns no value', async () => {
  const { id, home } = await session();
  await saveNamedSecret(home, 'salad/api-key', VALUE);
  const bin = join(root!, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'clikdeploy'), `#!/bin/sh\ncase "$3" in admin_platform_set_secret) printf '%s\\n' "$@" > "${root}/argv"; echo '{"status":"success","message":"stored"}';; *) echo '{}';; esac\n`);
  await chmod(join(bin, 'clikdeploy'), 0o755);
  process.env.PATH = `${bin}:${savedEnv.PATH}`;
  await attach(id); // the worker exists; nobody is asked anything
  const server = await mcpServer(id);
  const result = (await server.call('tools/call', { name: 'computer_web', arguments: { action: 'send_secret', secret: 'salad/api-key', send_to: [{ to: 'clikdeploy-secret', with: { key: 'SALAD_API_KEY' } }] } })).result;
  expect(result.isError).toBe(false);
  expect(result.content[0].text).toContain('SENT - clikdeploy-secret (SALAD_API_KEY)');
  expect(JSON.stringify(result)).not.toContain(VALUE);
  expect(await readFile(join(root!, 'argv'), 'utf8')).toContain(VALUE);
}, 60_000);

it('answers an unknown destination with the real list, so the agent can correct itself', async () => {
  const { id, home } = await session();
  await saveNamedSecret(home, 'salad/api-key', VALUE);
  await attach(id);
  const server = await mcpServer(id);
  const result = (await server.call('tools/call', { name: 'computer_web', arguments: { action: 'send_secret', secret: 'salad/api-key', send_to: [{ to: 'nowhere' }] } })).result;
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('no destination named "nowhere"');
  expect(result.content[0].text).toContain('clikdeploy-secret(key)');
}, 60_000);

it('refuses bad arguments with a plain reason, and honours computer off', async () => {
  const { id } = await session();
  await attach(id);
  const server = await mcpServer(id);
  const bad = await server.call('tools/call', { name: 'computer_web', arguments: { bogus: true } });
  expect(bad.result.isError).toBe(true);
  expect(bad.result.content[0].text).toContain('Invalid arguments');
  await mkdir(join(process.env.CLIKCODE_HOME!, 'computer'), { recursive: true });
  await writeFile(join(process.env.CLIKCODE_HOME!, 'computer', 'settings.json'), '{"enabled":false}\n');
  const off = await server.call('tools/call', { name: 'computer_web', arguments: { action: 'observe' } });
  expect(off.result.content[0].text).toContain('Computer use is off');
}, 60_000);

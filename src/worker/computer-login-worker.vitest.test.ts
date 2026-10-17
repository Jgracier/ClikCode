/** The saved-logins command against a real spawned worker: the window is asked,
 * the command only hears a count, and no username reaches anything but the
 * window. Uses the built entry (dist/index.js). */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import { allSavedLogins, lockCredentialVault, saveLoginFields } from '../agent/computer/credential-vault.js';
import { WorkerClient } from './client.js';
import { listWorkerRecords, readWorkerRecord } from './registry.js';
import type { WorkerEvent } from './protocol.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = join(repoRoot, 'dist', 'index.js');
const ENV_KEYS = ['CLIKCODE_HOME', 'CLIKCODE_WORKER_ENTRY', 'XDG_CONFIG_HOME', 'CLIKCODE_GATEWAY_URL_OVERRIDE'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
let root: string | undefined;
const clients: WorkerClient[] = [];

beforeAll(async () => {
  process.env.CLIKCODE_WORKER_ENTRY = distEntry;
  if (!await access(distEntry).then(() => true, () => false)) await promisify(execFile)('node', ['scripts/build.mjs'], { cwd: repoRoot });
}, 60_000);

afterAll(() => {
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  const pids = root ? (await listWorkerRecords().catch(() => [])).map(record => record.pid) : [];
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  for (const pid of pids) for (let wait = 0; wait < 300; wait++) { try { process.kill(pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 50)); }
  if (root) { lockCredentialVault(join(root, 'home')); await rm(root, { recursive: true, force: true }); root = undefined; }
});

async function session(): Promise<{ id: string; home: string }> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-worker-logins-'));
  const home = join(root, 'home');
  process.env.CLIKCODE_HOME = home;
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  // Nothing is listening here: the worker must not need the network for this.
  process.env.CLIKCODE_GATEWAY_URL_OVERRIDE = 'http://127.0.0.1:9';
  await mkdir(join(root, 'config', 'clikcode'), { recursive: true });
  await writeFile(join(root, 'config', 'clikcode', 'auth.json'), JSON.stringify({ apiUrl: 'http://127.0.0.1:9', apiKey: 'test-key' }));
  const workspace = join(root, 'work');
  await mkdir(workspace, { recursive: true });
  const state = await readState();
  const now = new Date().toISOString();
  const id = randomUUID();
  state.sessions.push({
    id, conversationId: randomUUID(), route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed',
    permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active', workspace, title: 'logins', nameSource: 'user', gatewayConfirmed: true,
  } as HarnessSession & { workspace: string });
  await writeState(state);
  return { id, home };
}

async function attach(id: string): Promise<WorkerClient> {
  const client = await WorkerClient.attach(id);
  clients.push(client);
  return client;
}

function next<T extends WorkerEvent['type']>(client: WorkerClient, type: T, timeoutMs = 20_000): Promise<Extract<WorkerEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('event', onEvent); reject(new Error(`timed out waiting for "${type}"`)); }, timeoutMs);
    const onEvent = (event: WorkerEvent): void => {
      if (event.type !== type) return;
      clearTimeout(timer);
      client.off('event', onEvent);
      resolve(event as Extract<WorkerEvent, { type: T }>);
    };
    client.on('event', onEvent);
  });
}

const pick = (id: string, label: string) => ({ type: 'question-response' as const, id, result: { kind: 'answered' as const, answers: { choice: [label] } } });

it('shows saved logins only in the window, removes the one chosen, and tells the command only a count', async () => {
  const { id, home } = await session();
  await saveLoginFields(home, 'https://accounts.google.com/', { username: 'one@example.com', password: 'pw-one' });
  await saveLoginFields(home, 'https://signin.aws.amazon.com/', { accountId: '123456789012', username: 'admin', password: 'pw-two' });
  const window = await attach(id);
  const command = await attach(id);

  const first = next(window, 'question-request');
  const result = next(command, 'computer-login-result');
  command.send({ type: 'computer-login', id: 'manage-1', manage: true });
  const picker = await first;
  expect(picker.request.title).toBe('Saved logins');
  expect(picker.request.questions[0]!.options.map(option => option.label)).toEqual([
    'accounts.google.com · one@example.com', 'signin.aws.amazon.com · 123456789012 · admin', 'Done',
  ]);
  expect(picker.request.questions[0]!.secret).toBe(true);
  // What the worker records about a waiting prompt carries no username.
  expect(JSON.stringify((await readWorkerRecord(id))?.awaitingApproval ?? {})).not.toMatch(/example|admin|123456789012/);

  const confirm = next(window, 'question-request');
  window.send(pick(picker.id, 'accounts.google.com · one@example.com'));
  const sure = await confirm;
  expect(sure.request.questions[0]!.options.map(option => option.label)).toEqual(['Remove', 'Keep']);
  expect(JSON.stringify(sure.request.questions[0])).not.toMatch(/example|admin/);

  const again = next(window, 'question-request');
  window.send(pick(sure.id, 'Remove'));
  const second = await again;
  expect(second.request.questions[0]!.options.map(option => option.label)).toEqual(['signin.aws.amazon.com · 123456789012 · admin', 'Done']);
  window.send(pick(second.id, 'Done'));

  const done = await result;
  expect(done).toEqual({ type: 'computer-login-result', id: 'manage-1', ok: true, message: 'Removed 1 saved login.' });
  expect((await allSavedLogins(home)).map(login => login.site)).toEqual(['signin.aws.amazon.com']);
}, 60_000);

it('removes nothing when the window dismisses the list', async () => {
  const { id, home } = await session();
  await saveLoginFields(home, 'https://accounts.google.com/', { username: 'one@example.com', password: 'pw-one' });
  const window = await attach(id);
  const command = await attach(id);
  const first = next(window, 'question-request');
  const result = next(command, 'computer-login-result');
  command.send({ type: 'computer-login', id: 'manage-2', manage: true });
  const picker = await first;
  window.send({ type: 'question-response', id: picker.id, result: { kind: 'cancelled' } });
  expect(await result).toMatchObject({ ok: true, message: 'No saved logins were removed.' });
  expect(await allSavedLogins(home)).toHaveLength(1);
}, 60_000);

it('says so, without a prompt, when no chat window is open to answer', async () => {
  const { id, home } = await session();
  await saveLoginFields(home, 'https://accounts.google.com/', { username: 'one@example.com', password: 'pw-one' });
  const command = await attach(id);
  const result = next(command, 'computer-login-result');
  command.send({ type: 'computer-login', id: 'manage-3', manage: true });
  const done = await result;
  expect(done.ok).toBe(false);
  expect(done.message).toBe('No chat window is open to show the prompt. Open this chat in the terminal or VS Code.');
  expect(await allSavedLogins(home)).toHaveLength(1);
}, 60_000);

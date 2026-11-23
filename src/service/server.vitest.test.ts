import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SignInScreen } from '../gateway/login/vendor-sign-in.js';
import { createServiceServer, tokenMatches, type ServiceBackend } from './server.js';
import { LoginRegistry, type LoginDriver, type LoginView } from './logins.js';
import type { ServiceAccount } from './accounts.js';
import type { TurnEvent, TurnRequest } from './turns.js';
import { serviceSettings } from '../commands/service.js';

const TOKEN = 'test-token-0123456789abcdef';

/** A vendor login, scripted: what it shows and asks, step by step, on the screen it is given. */
type Script = (screen: SignInScreen) => Promise<{ id: string }>;

function fakeDriver(scripts: Record<string, Script>, installs: string[] = []): LoginDriver & { installed: string[] } {
  const installed: string[] = [];
  return {
    installed,
    resolve: (provider) => (scripts[provider] ? { command: provider, provider } : undefined),
    needsInstall: async (command) => installs.includes(command) && !installed.includes(command),
    install: async (command) => { await new Promise((resolve) => setTimeout(resolve, 30)); installed.push(command); },
    signIn: (command, _options, screen) => scripts[command]!(screen),
  };
}

const ACCOUNT: ServiceAccount = { id: 'acct-1', provider: 'anthropic', harness: 'claude', label: 'me@example.com', status: 'connected' };

function fakeBackend(driver: LoginDriver, overrides: Partial<ServiceBackend> = {}): ServiceBackend & { removed: string[]; turns: TurnRequest[] } {
  const removed: string[] = [];
  const turns: TurnRequest[] = [];
  return {
    removed, turns,
    version: '1.0.0-test', commit: 'abc123',
    logins: new LoginRegistry(driver, 5_000),
    providers: async () => [{ provider: 'anthropic', harness: 'claude', name: 'Claude Code', loginKinds: ['url-code'], installed: true }],
    accounts: async () => [ACCOUNT],
    account: async (id) => (id === ACCOUNT.id ? ACCOUNT : undefined),
    checkAccount: async (id) => (id === ACCOUNT.id ? { ...ACCOUNT, checkedAt: '2026-11-23T00:00:00.000Z' } : undefined),
    removeAccount: async (id) => { if (id !== ACCOUNT.id) return false; removed.push(id); return true; },
    runTurn: async (request, emit) => {
      turns.push(request);
      emit({ type: 'text', text: 'Hel' });
      emit({ type: 'text', text: 'lo' });
      emit({ type: 'usage', inputTokens: 3, outputTokens: 2 });
      emit({ type: 'done', stopReason: 'completed' });
    },
    ...overrides,
  };
}

let server: Server | undefined;
let base = '';
const logLines: string[] = [];

async function start(backend: ServiceBackend): Promise<void> {
  server = createServiceServer(backend, { token: TOKEN, log: (line) => logLines.push(line) });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const auth = { authorization: `Bearer ${TOKEN}` };
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = auth): Promise<{ status: number; json: any; headers: Headers }> {
  const response = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined, headers: response.headers };
}

async function until(path: string, done: (view: LoginView) => boolean): Promise<LoginView> {
  for (let tries = 0; tries < 200; tries += 1) {
    const { json } = await call('GET', path);
    if (done(json)) return json;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`never reached the wanted state at ${path}`);
}

beforeEach(() => { logLines.length = 0; });
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => { server!.closeAllConnections(); server!.close(() => resolve()); });
  server = undefined;
});

describe('auth', () => {
  it('serves /health without a token, with the version', async () => {
    await start(fakeBackend(fakeDriver({})));
    const health = await call('GET', '/health', undefined, {});
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true, version: '1.0.0-test', commit: 'abc123' });
    expect(health.headers.get('x-clikcode-service')).toBe('1');
  });

  it('refuses every other route without the right bearer token', async () => {
    await start(fakeBackend(fakeDriver({})));
    for (const headers of [{}, { authorization: 'Bearer wrong-token-xxxxxxxxxxxx' }, { authorization: TOKEN }] as Record<string, string>[]) {
      const response = await call('GET', '/v1/accounts', undefined, headers);
      expect(response.status).toBe(401);
      expect(response.json.error.code).toBe('unauthorized');
    }
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`bearer  ${TOKEN} `, TOKEN)).toBe(true);
  });

  it('will not start without a token, binds loopback unless told otherwise', () => {
    expect(serviceSettings({})).toEqual({ error: expect.stringContaining('CLIKCODE_SERVICE_TOKEN') });
    expect(serviceSettings({ CLIKCODE_SERVICE_TOKEN: 'short' })).toEqual({ error: expect.stringContaining('at least') });
    expect(serviceSettings({ CLIKCODE_SERVICE_TOKEN: TOKEN })).toEqual({ token: TOKEN, port: 4050, host: '127.0.0.1' });
    expect(serviceSettings({ CLIKCODE_SERVICE_TOKEN: TOKEN, CLIKCODE_SERVICE_PORT: '5000', CLIKCODE_SERVICE_HOST: '0.0.0.0' })).toEqual({ token: TOKEN, port: 5000, host: '0.0.0.0' });
    expect(serviceSettings({ CLIKCODE_SERVICE_TOKEN: TOKEN, CLIKCODE_SERVICE_PORT: 'x' })).toEqual({ error: expect.stringContaining('not a port') });
  });
});

describe('routes', () => {
  it('lists providers and accounts, checks and removes one', async () => {
    const backend = fakeBackend(fakeDriver({}));
    await start(backend);
    expect((await call('GET', '/v1/providers')).json.providers[0]).toMatchObject({ provider: 'anthropic', harness: 'claude', loginKinds: ['url-code'], installed: true });
    expect((await call('GET', '/v1/accounts')).json).toEqual({ accounts: [ACCOUNT] });
    expect((await call('GET', '/v1/accounts/acct-1')).json).toEqual(ACCOUNT);
    expect((await call('POST', '/v1/accounts/acct-1/check')).json).toMatchObject({ id: 'acct-1', checkedAt: '2026-11-23T00:00:00.000Z' });
    expect((await call('POST', '/v1/accounts/nope/check')).status).toBe(404);
    expect((await call('DELETE', '/v1/accounts/acct-1')).json).toEqual({ ok: true, removed: 'acct-1' });
    expect(backend.removed).toEqual(['acct-1']);
    const missing = await call('DELETE', '/v1/accounts/nope');
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('account-not-found');
    expect((await call('PUT', '/v1/accounts')).status).toBe(405);
    expect((await call('GET', '/v1/elsewhere')).status).toBe(404);
  });

  it('answers an internal failure without its text', async () => {
    await start(fakeBackend(fakeDriver({}), { accounts: async () => { throw new Error('vendor said sk-ant-secret'); } }));
    const response = await call('GET', '/v1/accounts');
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.json)).not.toContain('sk-ant');
  });
});

describe('logins', () => {
  it('runs a link-and-pasted-code sign-in: awaiting-user, awaiting-input, connected', async () => {
    let pasted = '';
    const driver = fakeDriver({
      claude: async (screen) => {
        screen.show({ url: 'https://claude.ai/oauth/authorize?code=true' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        pasted = await screen.ask('Paste code here if prompted', false);
        return { id: 'acct-new' };
      },
    }, ['claude']);
    await start(fakeBackend(driver));
    const created = await call('POST', '/v1/logins', { provider: 'claude', label: 'work' });
    expect(created.status).toBe(201);
    const path = `/v1/logins/${created.json.loginId}`;
    const awaitingInput = await until(path, (view) => view.state === 'awaiting-input');
    expect(driver.installed).toEqual(['claude']);
    expect(awaitingInput).toMatchObject({ provider: 'claude', verificationUrl: 'https://claude.ai/oauth/authorize?code=true', prompt: 'Paste code here if prompted' });
    const answered = await call('POST', `${path}/input`, { value: 'the-secret-code-123' });
    expect(answered.status).toBe(200);
    const done = await until(path, (view) => view.state === 'connected');
    expect(done).toMatchObject({ state: 'connected', accountId: 'acct-new' });
    expect(done.verificationUrl).toBeUndefined();
    expect(pasted).toBe('the-secret-code-123');
    // Never logged, never returned.
    expect(logLines.join('\n')).not.toContain('the-secret-code-123');
    expect(JSON.stringify(done)).not.toContain('the-secret-code-123');
  });

  it('shows the installing step, then a device code as awaiting-user', async () => {
    let finish: () => void = () => undefined;
    const driver = fakeDriver({
      codex: async (screen) => {
        screen.show({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' });
        await new Promise<void>((resolve) => { finish = resolve; });
        return { id: 'acct-codex' };
      },
    }, ['codex']);
    await start(fakeBackend(driver));
    const { json } = await call('POST', '/v1/logins', { provider: 'codex' });
    const path = `/v1/logins/${json.loginId}`;
    expect((await call('GET', path)).json.state).toMatch(/starting|installing/);
    const waiting = await until(path, (view) => view.state === 'awaiting-user');
    expect(waiting).toMatchObject({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' });
    expect((await call('POST', `${path}/input`, { value: 'x' })).json.error.code).toBe('not-awaiting-input');
    finish();
    expect(await until(path, (view) => view.state === 'connected')).toMatchObject({ accountId: 'acct-codex' });
  });

  it('a key field offered beside the link keeps the state awaiting-user and still takes a key', async () => {
    let got = '';
    const driver = fakeDriver({
      cline: async (screen) => {
        screen.show({ url: 'https://app.cline.bot/auth' });
        got = await screen.ask('Or paste your Cline API key', true, true, true);
        return { id: 'acct-cline' };
      },
    });
    await start(fakeBackend(driver));
    const path = `/v1/logins/${(await call('POST', '/v1/logins', { provider: 'cline' })).json.loginId}`;
    const view = await until(path, (item) => item.state === 'awaiting-user' && Boolean(item.acceptsInput));
    expect(view.prompt).toBe('Or paste your Cline API key');
    await call('POST', `${path}/input`, { value: 'sk-cline-0123456789abcdef' });
    expect(await until(path, (item) => item.state === 'connected')).toMatchObject({ accountId: 'acct-cline' });
    expect(got).toBe('sk-cline-0123456789abcdef');
  });

  it('answers a method menu with the device sign-in, and asks any other menu by number', async () => {
    const picked: Array<number | undefined> = [];
    const driver = fakeDriver({
      opencode: async (screen) => {
        picked.push(await screen.choose('Login method', ['ChatGPT (browser)', 'ChatGPT (headless)', 'API key']));
        picked.push(await screen.choose('Select provider', ['OpenAI', 'Anthropic', 'Google']));
        return { id: 'acct-oc' };
      },
    });
    await start(fakeBackend(driver));
    const path = `/v1/logins/${(await call('POST', '/v1/logins', { provider: 'opencode' })).json.loginId}`;
    const asking = await until(path, (view) => view.state === 'awaiting-input');
    expect(asking.choices).toEqual(['OpenAI', 'Anthropic', 'Google']);
    expect(asking.prompt).toContain('2) Anthropic');
    expect((await call('POST', `${path}/input`, { value: '9' })).status).toBe(400);
    await call('POST', `${path}/input`, { value: 'anthropic' });
    await until(path, (view) => view.state === 'connected');
    expect(picked).toEqual([1, 1]);
  });

  it('reports a failed sign-in without what was typed into it', async () => {
    const driver = fakeDriver({
      claude: async (screen) => {
        const code = await screen.ask('Paste code here if prompted', false);
        throw new Error(`OAuth error: invalid code ${code}`);
      },
    });
    await start(fakeBackend(driver));
    const path = `/v1/logins/${(await call('POST', '/v1/logins', { provider: 'claude' })).json.loginId}`;
    await until(path, (view) => view.state === 'awaiting-input');
    await call('POST', `${path}/input`, { value: 'pasted-code-value' });
    const failed = await until(path, (view) => view.state === 'failed');
    expect(failed.error).toContain('invalid code');
    expect(failed.error).not.toContain('pasted-code-value');
  });

  it('cancels: the vendor is stopped and its question withdrawn', async () => {
    let stopped = false;
    let answer: string | undefined;
    const driver = fakeDriver({
      claude: async (screen) => {
        screen.signal.addEventListener('abort', () => { stopped = true; });
        answer = await screen.ask('Paste code here if prompted', false);
        throw new Error('cancelled');
      },
    });
    await start(fakeBackend(driver));
    const path = `/v1/logins/${(await call('POST', '/v1/logins', { provider: 'claude' })).json.loginId}`;
    await until(path, (view) => view.state === 'awaiting-input');
    const cancelled = await call('DELETE', path);
    expect(cancelled.json).toMatchObject({ state: 'failed', error: 'cancelled' });
    expect(stopped).toBe(true);
    expect(answer).toBe('');
  });

  it('times out a sign-in nobody finishes', async () => {
    const driver = fakeDriver({ slow: (screen) => new Promise((_resolve, reject) => { screen.signal.addEventListener('abort', () => reject(new Error('stopped'))); }) });
    const backend = fakeBackend(driver, { logins: new LoginRegistry(driver, 50) });
    await start(backend);
    const path = `/v1/logins/${(await call('POST', '/v1/logins', { provider: 'slow' })).json.loginId}`;
    expect(await until(path, (view) => view.state === 'timeout')).toMatchObject({ state: 'timeout' });
  });

  it('refuses an unknown provider, a missing login and a reconnect of no account', async () => {
    await start(fakeBackend(fakeDriver({})));
    expect((await call('POST', '/v1/logins', { provider: 'nobody' })).json.error.code).toBe('unknown-provider');
    expect((await call('POST', '/v1/logins', {})).status).toBe(400);
    expect((await call('GET', '/v1/logins/nope')).status).toBe(404);
    expect((await call('POST', '/v1/logins', { provider: 'claude', accountId: 'missing' })).status).toBe(404);
  });
});

describe('turns', () => {
  it('streams the turn as NDJSON', async () => {
    const backend = fakeBackend(fakeDriver({}));
    await start(backend);
    const response = await fetch(`${base}/v1/turns`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'acct-1', model: 'opus', messages: [{ role: 'user', content: 'hi' }], mcp: { url: 'https://app.example/mcp', headers: { authorization: 'Bearer x' } }, timeoutMs: 1000 }),
    });
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as TurnEvent);
    expect(events.map((event) => event.type)).toEqual(['text', 'text', 'usage', 'done']);
    expect(backend.turns[0]).toMatchObject({ accountId: 'acct-1', model: 'opus', timeoutMs: 1000, mcp: { url: 'https://app.example/mcp' } });
  });

  it('rejects a malformed turn before streaming, and a turn on no account', async () => {
    await start(fakeBackend(fakeDriver({})));
    expect((await call('POST', '/v1/turns', { accountId: 'acct-1', messages: [] })).status).toBe(400);
    expect((await call('POST', '/v1/turns', { accountId: 'acct-1', messages: [{ role: 'assistant', content: 'x' }] })).status).toBe(400);
    expect((await call('POST', '/v1/turns', { accountId: 'acct-1', messages: [{ role: 'user', content: 'x' }], mcp: { url: 'ftp://x' } })).status).toBe(400);
    expect((await call('POST', '/v1/turns', { accountId: 'nope', messages: [{ role: 'user', content: 'x' }] })).status).toBe(404);
  });

  it('a turn that throws still ends its stream with an error event', async () => {
    await start(fakeBackend(fakeDriver({}), { runTurn: async () => { throw new Error('boom sk-secret'); } }));
    const response = await fetch(`${base}/v1/turns`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'acct-1', messages: [{ role: 'user', content: 'x' }] }) });
    const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([{ type: 'error', reason: 'crashed', message: 'The turn could not be run.' }]);
  });

  it('stops the turn when the caller goes away', async () => {
    let aborted = false;
    await start(fakeBackend(fakeDriver({}), {
      runTurn: (_request, emit, signal) => new Promise<void>((resolve) => {
        emit({ type: 'text', text: 'working' });
        signal.addEventListener('abort', () => { aborted = true; resolve(); });
      }),
    }));
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/turns`, { method: 'POST', signal: controller.signal, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'acct-1', messages: [{ role: 'user', content: 'x' }] }) });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    for (let tries = 0; tries < 100 && !aborted; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
  });
});

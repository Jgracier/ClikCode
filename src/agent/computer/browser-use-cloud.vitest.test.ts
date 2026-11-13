/** The Browser Use Cloud session: created once, reused, never forgotten while it may still be billing. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const connectOverCDP = vi.fn();
vi.mock('playwright-core', () => ({ chromium: { connectOverCDP: (...args: unknown[]) => connectOverCDP(...args) } }));

const { browserUseConnection, browserUseLiveUrl, browserUseStatus, stopBrowserUse } = await import('./browser-use-cloud.js');

type Call = { url: string; method: string; body?: unknown; key?: string };
let dir: string;
let calls: Call[];
let reply: (call: Call) => { status?: number; json?: unknown };
const fakeBrowser = () => ({ contexts: () => [{ pages: () => [] }], close: vi.fn(async () => undefined) });
const record = async (): Promise<unknown> => JSON.parse(await fs.readFile(path.join(dir, 'computer', 'browser-use.json'), 'utf8'));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-cloud-'));
  calls = [];
  process.env.BROWSER_USE_API_KEY = 'test-key';
  connectOverCDP.mockReset();
  connectOverCDP.mockImplementation(async () => fakeBrowser());
  reply = call => call.method === 'POST' ? { json: { id: 's1', cdpUrl: 'wss://cdp.browser-use.com/s1' } } : { json: { id: 's1', status: 'active', cdpUrl: 'wss://cdp.browser-use.com/s1', liveUrl: 'https://live.browser-use.com/s1' } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string; headers: Record<string, string> }) => {
    const call: Call = { url, method: init.method ?? 'GET', ...(init.body ? { body: JSON.parse(init.body) } : {}), key: init.headers['X-Browser-Use-API-Key'] };
    calls.push(call);
    const { status = 200, json = {} } = reply(call);
    return { ok: status < 400, status, json: async () => json };
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); delete process.env.BROWSER_USE_API_KEY; await fs.rm(dir, { recursive: true, force: true }); });

describe('Browser Use Cloud session', () => {
  it('starts nothing when only asked to attach', async () => {
    expect(await browserUseConnection(dir, false)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('creates one session with captcha solving on, records it privately, and reuses it', async () => {
    expect(await browserUseConnection(dir, true)).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', key: 'test-key', body: { solveCaptchas: true } });
    expect(await record()).toEqual({ id: 's1', cdpUrl: 'wss://cdp.browser-use.com/s1' });
    expect((await fs.stat(path.join(dir, 'computer', 'browser-use.json'))).mode & 0o777).toBe(0o600);
    await browserUseConnection(dir, true);
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(await browserUseStatus(dir)).toEqual({ configured: true, active: true });
  });

  it('refuses a connection address that is not Browser Use\'s, and stops the session it cannot use', async () => {
    reply = call => call.method === 'POST' ? { json: { id: 's2', cdpUrl: 'wss://evil.example/s2' } } : {};
    await expect(browserUseConnection(dir, true)).rejects.toThrow(/supported CDP connection/);
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { action: 'stop' } });
    expect(connectOverCDP).not.toHaveBeenCalled();
    await expect(record()).rejects.toThrow();
  });

  it('stops the billed session and forgets it; a session already gone counts as stopped', async () => {
    await browserUseConnection(dir, true);
    expect(await stopBrowserUse(dir)).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: expect.stringContaining('/browsers/s1'), body: { action: 'stop' } });
    await expect(record()).rejects.toThrow();
    expect(await stopBrowserUse(dir)).toBe(false);

    await browserUseConnection(dir, true);
    reply = () => ({ status: 404 });
    expect(await stopBrowserUse(dir)).toBe(true);
    await expect(record()).rejects.toThrow();
  });

  it('keeps the record when a stop fails, so a session that may still bill is not forgotten', async () => {
    await browserUseConnection(dir, true);
    reply = () => ({ status: 500 });
    await expect(stopBrowserUse(dir)).rejects.toThrow(/HTTP 500/);
    expect(await record()).toMatchObject({ id: 's1' });
  });

  it('starts a new session only after the service confirms the old one stopped', async () => {
    await browserUseConnection(dir, true);
    connectOverCDP.mockImplementationOnce(async () => { throw new Error('closed'); }).mockImplementationOnce(async () => { throw new Error('closed'); });
    reply = call => call.method === 'POST' ? { json: { id: 's3', cdpUrl: 'wss://cdp.browser-use.com/s3' } } : { json: { id: 's1', status: 'stopped' } };
    expect(await browserUseConnection(dir, true)).toBeDefined();
    expect(await record()).toMatchObject({ id: 's3' });
  });

  it('leaves a session running that is active but unreachable, instead of starting a second billed one', async () => {
    await browserUseConnection(dir, true);
    connectOverCDP.mockImplementation(async () => { throw new Error('unreachable'); });
    await expect(browserUseConnection(dir, true)).rejects.toThrow(/still active/);
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('gives the live-control link only for an active session on Browser Use\'s own host', async () => {
    await expect(browserUseLiveUrl(dir)).rejects.toThrow(/No Browser Use Cloud session/);
    await browserUseConnection(dir, true);
    expect(await browserUseLiveUrl(dir)).toBe('https://live.browser-use.com/s1');
    reply = () => ({ json: { status: 'active', liveUrl: 'https://elsewhere.example/x' } });
    await expect(browserUseLiveUrl(dir)).rejects.toThrow(/unsupported live-view host/);
  });

  it('says what to do when no key is saved', async () => {
    delete process.env.BROWSER_USE_API_KEY;
    await expect(browserUseConnection(dir, true)).rejects.toThrow(/browser-use\/api-key/);
    expect((await browserUseStatus(dir)).configured).toBe(false);
  });
});

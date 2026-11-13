/** Optional Browser Use Cloud CDP backend. The API key and CDP URL stay local; neither is returned to the model. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext } from 'playwright-core';
import { namedSecretNames, readNamedSecret } from './credential-vault.js';
import { tryLease } from '../../session/store/locks.js';
import { sleep } from '../../runtime/sleep.js';
import { quiet, lifecycle } from '../../runtime/lifecycle-log.js';

const API = 'https://api.browser-use.com/api/v4';
const recordPath = (stateDir: string): string => path.join(stateDir, 'computer', 'browser-use.json');
type SessionRecord = { id: string; cdpUrl: string };
type Connected = { browser: Browser; context: BrowserContext };

async function apiKey(stateDir: string): Promise<string> {
  const fromEnv = process.env.BROWSER_USE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try { return await readNamedSecret(stateDir, 'browser-use/api-key'); }
  catch { throw new Error('Browser Use needs a key. Save it in ClikCode Secrets as `browser-use/api-key`, then run `clikcode computer browser-use on`.'); }
}

function safeCdpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'wss:' || url.protocol === 'https:') && (url.hostname === 'browser-use.com' || url.hostname.endsWith('.browser-use.com'));
  } catch { return false; }
}

async function request<T>(key: string, endpoint: string, method = 'GET', body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${endpoint}`, {
      method, headers: { 'X-Browser-Use-API-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new Error('Browser Use Cloud could not be reached. Check the network and try again.'); }
  if (!response.ok) throw new Error(`Browser Use Cloud returned HTTP ${response.status}. Check its API key, credits and session status.`);
  return await response.json() as T;
}

async function readRecord(stateDir: string): Promise<SessionRecord | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(recordPath(stateDir), 'utf8')) as Partial<SessionRecord>;
    return typeof value.id === 'string' && safeCdpUrl(value.cdpUrl) ? { id: value.id, cdpUrl: value.cdpUrl } : undefined;
  } catch { return undefined; }
}

async function persistRecord(stateDir: string, record: SessionRecord): Promise<void> {
  const file = recordPath(stateDir);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(quiet('agent/computer/browser-use-cloud')); }
}

/** Confirm a failed CDP connection is actually an expired/stopped cloud session before creating another billed one. */
async function activeRecord(stateDir: string, key: string, record: SessionRecord): Promise<SessionRecord | undefined> {
  try {
    const current = await request<{ id?: unknown; status?: unknown; cdpUrl?: unknown }>(key, `/browsers/${encodeURIComponent(record.id)}`);
    if (current.status === 'active' && safeCdpUrl(current.cdpUrl)) return { id: record.id, cdpUrl: current.cdpUrl };
    if (current.status === 'stopped') {
      await fs.unlink(recordPath(stateDir)).catch(quiet('agent/computer/browser-use-cloud'));
      return undefined;
    }
    throw new Error('Browser Use Cloud reports a session state ClikCode cannot safely replace.');
  } catch (error) {
    if (error instanceof Error && error.message.includes('HTTP 404')) {
      await fs.unlink(recordPath(stateDir)).catch(quiet('agent/computer/browser-use-cloud'));
      return undefined;
    }
    throw error;
  }
}

async function connect(url: string): Promise<Connected | undefined> {
  try {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.connectOverCDP(url, { timeout: 10_000 });
    const context = browser.contexts()[0];
    if (!context) { await browser.close(); return undefined; }
    return { browser, context };
  } catch { return undefined; }
}

async function stopRecord(stateDir: string, key: string, record: SessionRecord): Promise<void> {
  try { await request(key, `/browsers/${encodeURIComponent(record.id)}`, 'PATCH', { action: 'stop' }); }
  catch (error) {
    // A timed-out cloud session may already have been collected. Keep all other failed stops on disk
    // so a billing session is never forgotten after a network or authentication error.
    if (!(error instanceof Error) || !error.message.includes('HTTP 404')) throw error;
  }
  await fs.unlink(recordPath(stateDir)).catch(quiet('agent/computer/browser-use-cloud'));
}

async function startSession(stateDir: string, key: string): Promise<SessionRecord> {
  const created = await request<{ id?: unknown; cdpUrl?: unknown }>(key, '/browsers', 'POST', {
    timeout: 60,
    solveCaptchas: true,
    metadata: { client: 'clikcode' },
  });
  if (typeof created.id !== 'string' || !safeCdpUrl(created.cdpUrl)) {
    if (typeof created.id === 'string') await request(key, `/browsers/${encodeURIComponent(created.id)}`, 'PATCH', { action: 'stop' }).catch(quiet('agent/computer/browser-use-cloud'));
    throw new Error('Browser Use Cloud created a session but did not return a supported CDP connection.');
  }
  const record = { id: created.id, cdpUrl: created.cdpUrl };
  try { await persistRecord(stateDir, record); }
  catch (error) {
    await request(key, `/browsers/${encodeURIComponent(record.id)}`, 'PATCH', { action: 'stop' }).catch(quiet('agent/computer/browser-use-cloud'));
    throw error;
  }
  lifecycle('browser.cloud.started', { provider: 'browser-use' });
  return record;
}

/** Connect to this ClikCode install's one managed browser. Local cookies are never copied to the cloud. */
export async function browserUseConnection(stateDir: string, start: boolean): Promise<Connected | undefined> {
  let record = await readRecord(stateDir);
  if (record) {
    const connected = await connect(record.cdpUrl);
    if (connected) return connected;
    if (!start) return undefined;
  } else if (!start) return undefined;

  const leasePath = path.join(stateDir, 'computer', 'browser-use-start.lock');
  const lease = await tryLease(leasePath);
  if (!lease) {
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      record = await readRecord(stateDir);
      if (record) {
        const connected = await connect(record.cdpUrl);
        if (connected) return connected;
      }
    }
    throw new Error('Another ClikCode worker is starting the managed browser; retry shortly.');
  }
  try {
    record = await readRecord(stateDir);
    if (record) {
      const connected = await connect(record.cdpUrl);
      if (connected) return connected;
      const key = await apiKey(stateDir);
      const active = await activeRecord(stateDir, key, record);
      if (active) {
        record = active;
        await persistRecord(stateDir, record);
        const retry = await connect(record.cdpUrl);
        if (retry) return retry;
        throw new Error('The Browser Use Cloud session is still active but its CDP connection is unavailable. It was left running; retry or stop it with `clikcode computer browser-use off`.');
      }
    }
    const key = await apiKey(stateDir);
    record = await startSession(stateDir, key);
    const connected = await connect(record.cdpUrl);
    if (connected) return connected;
    await stopRecord(stateDir, key, record);
    throw new Error('Browser Use Cloud started, but Playwright could not connect to it.');
  } finally { await lease.release(); }
}

/** Explicitly stop the billed cloud session. Releasing a worker connection alone leaves it running. */
export async function stopBrowserUse(stateDir: string): Promise<boolean> {
  const record = await readRecord(stateDir);
  if (!record) return false;
  await stopRecord(stateDir, await apiKey(stateDir), record);
  lifecycle('browser.cloud.stopped', { provider: 'browser-use' });
  return true;
}

export async function browserUseStatus(stateDir: string): Promise<{ configured: boolean; active: boolean }> {
  const record = await readRecord(stateDir);
  const names = await namedSecretNames(stateDir).catch(() => [] as string[]);
  const configured = Boolean(process.env.BROWSER_USE_API_KEY?.trim() || names.some(name => name.toLowerCase() === 'browser-use/api-key'));
  return { configured, active: Boolean(record) };
}

/** The live-control URL is a bearer link: return it only to the user's interactive CLI, never an agent tool. */
export async function browserUseLiveUrl(stateDir: string): Promise<string> {
  const record = await readRecord(stateDir);
  if (!record) throw new Error('No Browser Use Cloud session is active.');
  const key = await apiKey(stateDir);
  const current = await request<{ liveUrl?: unknown; status?: unknown }>(key, `/browsers/${encodeURIComponent(record.id)}`);
  if (current.status !== 'active' || typeof current.liveUrl !== 'string') throw new Error('The Browser Use Cloud session has no active live view.');
  let url: URL;
  try { url = new URL(current.liveUrl); } catch { throw new Error('Browser Use Cloud returned an invalid live-view link.'); }
  if (url.protocol !== 'https:' || !(url.hostname === 'browser-use.com' || url.hostname.endsWith('.browser-use.com'))) throw new Error('Browser Use Cloud returned an unsupported live-view host.');
  return url.href;
}

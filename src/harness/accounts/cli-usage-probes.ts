/** Plan usage that five more harnesses publish without a model turn, each
 * asked of the harness itself (its own credentials, its own token refresh):
 *
 *   - Copilot: `copilot --headless --stdio` serves the Copilot SDK's JSON-RPC,
 *     whose `account.getQuota` answers the quota snapshots its TUI shows.
 *   - Kimi Code: `kimi web --no-open` serves `/api/v1/oauth/usage`, the same
 *     read its `/usage` makes (the 5h / 7d / monthly windows).
 *   - Amp: `amp usage` prints the account's credit balance.
 *   - Kilo: `kilo profile` prints the Kilo account's balance.
 *   - Cursor: the dashboard call its own usage screen makes
 *     (`DashboardService/GetCurrentPeriodUsage`), with the token the CLI
 *     keeps in ~/.config/cursor/auth.json. Verified 2026-09-30.
 *
 * Verified against copilot 1.0.88, kimi 2.0.2, amp 0.0.1790126705 and kilo
 * 7.7.6 on this machine's accounts (2026-09-30). None opens a session. */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnPortable, terminatePortable } from '../transport/spawn.js';
import { resolveBinaryPath } from '../transport/native/binary.js';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import type { HarnessSession } from '../../session/model.js';
import { type UsageReading, type UsageWindow, usageReading, usageWindow } from './usage-reading.js';

type Json = Record<string, any>;
type Environment = Readonly<Record<string, string>>;

const PROBE_TIMEOUT_MS = 15_000;

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function catalogBinary(command: string, fallback: string): string {
  try { return localHarnessForCommand(command)?.binary ?? fallback; } catch { return fallback; } // fail-open-ok: the catalog default is the documented binary
}

/** A reset time the vendor stated, or nothing. Copilot's SDK puts the
 * request's own time in `resetDate` when it has no reset to report; taken at
 * its word that would read as a window that had already reset. */
function futureReset(value: unknown, now: number): string | undefined {
  const at = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(at) && at > now + 60_000 ? new Date(at).toISOString() : undefined;
}

/** A credit balance as a label, the wording Auggie's uses. Not a window: a
 * balance has no share used, so it never marks an account spent. */
function balanceLabel(amount: number): string {
  return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)} credits left`;
}

// ---------------------------------------------------------------- Copilot

/** The windows in an `account.getQuota` result. `completions` is inline
 * code completion, which the CLI agent never spends, so it is left out; an
 * unlimited or zero entitlement is not a limit. */
export function copilotQuotaReading(result: unknown, now = Date.now()): UsageReading | undefined {
  const snapshots = (result as Json | undefined)?.quotaSnapshots as Record<string, Json> | undefined;
  if (!snapshots || typeof snapshots !== 'object') return undefined;
  const names: Record<string, string> = { premium_interactions: 'premium', chat: 'chat' };
  const windows: Array<UsageWindow | undefined> = Object.entries(names).map(([key, name]) => {
    const snapshot = snapshots[key];
    if (!snapshot || snapshot.isUnlimitedEntitlement === true || !(Number(snapshot.entitlementRequests) > 0)) return undefined;
    const remaining = Number(snapshot.remainingPercentage);
    const used = Number.isFinite(remaining) ? 100 - remaining : (Number(snapshot.usedRequests) / Number(snapshot.entitlementRequests)) * 100;
    return usageWindow(name, used, futureReset(snapshot.resetDate ?? snapshot.resetDateEpochMs, now));
  });
  return usageReading(windows);
}

/** One JSON-RPC request over the Content-Length framing the Copilot SDK
 * server speaks (not ACP's newline framing). */
function contentLengthRequest(binary: string, argv: readonly string[], environment: Environment, method: string, params: Json): Promise<Json | undefined> {
  return new Promise((resolve) => {
    const child = spawnPortable(binary, [...argv], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...environment } });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (value?: Json): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminatePortable(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish(), PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1]);
        if (!Number.isFinite(length) || buffer.length < headerEnd + 4 + length) return;
        const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
        buffer = buffer.subarray(headerEnd + 4 + length);
        try {
          const message = JSON.parse(body) as Json;
          if (message.id === 1) return finish(message.result as Json | undefined);
        } catch { /* fail-open-ok: a malformed frame is not the answer; the timeout ends the probe */ }
      }
    });
    child.once('error', () => finish());
    child.once('exit', () => finish());
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    child.stdin!.on('error', () => undefined);
    child.stdin!.write(`Content-Length: ${payload.length}\r\n\r\n`);
    child.stdin!.write(payload);
  });
}

export async function copilotUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  const binary = await resolveBinaryPath(catalogBinary('copilot', 'copilot'));
  if (!binary) return undefined;
  // --no-auto-update: a probe must not start a self-update.
  return copilotQuotaReading(await contentLengthRequest(binary, ['--headless', '--no-auto-update', '--stdio'], environment, 'account.getQuota', {}));
}

// ---------------------------------------------------------------- Kimi

/** Kimi's own normalized quota (`managedUsageResultSchema`): each window a
 * `usedRatio` (0..1) and an optional `resetAt`. */
export function kimiQuotaReading(result: unknown): UsageReading | undefined {
  const data = (result as Json | undefined)?.data ?? result;
  if ((data as Json | undefined)?.kind !== 'ok') return undefined;
  const usages = (data as Json).quota?.usages as Record<string, Json> | undefined;
  if (!usages) return undefined;
  const window = (name: string, entry: Json | undefined): UsageWindow | undefined =>
    typeof entry?.usedRatio === 'number' ? usageWindow(name, entry.usedRatio * 100, entry.resetAt) : undefined;
  return usageReading([window('5h', usages.limit5h), window('weekly', usages.limit7d), window('monthly', usages.monthTotal)]);
}

/** The server's address and bearer token from `kimi web`'s startup banner. */
export function kimiWebEndpoint(banner: string): { url: string; token: string } | undefined {
  const text = stripAnsi(banner);
  const local = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)\/?#token=([A-Za-z0-9_-]+)/.exec(text);
  if (local) return { url: local[1]!, token: local[2]! };
  const url = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(text)?.[1];
  const token = /Token:\s+([A-Za-z0-9_-]+)/.exec(text)?.[1];
  return url && token ? { url, token } : undefined;
}

export async function kimiUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  const binary = await resolveBinaryPath(catalogBinary('kimi', 'kimi'));
  if (!binary) return undefined;
  // Port 0: never collides with a `kimi web` the user is running.
  const child = spawnPortable(binary, ['web', '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...environment } });
  try {
    const endpoint = await new Promise<{ url: string; token: string } | undefined>((resolve) => {
      let banner = '';
      const timer = setTimeout(() => resolve(undefined), PROBE_TIMEOUT_MS);
      timer.unref();
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        banner += chunk;
        const found = kimiWebEndpoint(banner);
        if (found) { clearTimeout(timer); resolve(found); }
      });
      child.once('exit', () => { clearTimeout(timer); resolve(undefined); });
      child.once('error', () => { clearTimeout(timer); resolve(undefined); });
    });
    if (!endpoint) return undefined;
    const response = await fetch(`${endpoint.url}/api/v1/oauth/usage`, {
      headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok ? kimiQuotaReading(await response.json()) : undefined;
  } catch {
    return undefined; // fail-open-ok: no figure beats a wrong one
  } finally {
    terminatePortable(child);
  }
}

// ---------------------------------------------------------------- Cursor

/** A `GetCurrentPeriodUsage` answer as windows. `totalPercentUsed` is the
 * plan's included usage -- what Cursor's own "You've used 7% of your
 * included total usage" rounds -- and `apiPercentUsed` the separate share for
 * named (non-Auto) models. Both reset at `billingCycleEnd`, epoch ms. */
export function cursorQuotaReading(result: unknown): UsageReading | undefined {
  const plan = (result as Json | undefined)?.planUsage as Json | undefined;
  if (!plan) return undefined;
  const end = Number((result as Json).billingCycleEnd);
  const reset = Number.isFinite(end) && end > 0 ? end : undefined;
  return usageReading([usageWindow('monthly', plan.totalPercentUsed, reset), usageWindow('API', plan.apiPercentUsed, reset)]);
}

async function cursorAccessToken(environment: Environment): Promise<string | undefined> {
  const home = environment.HOME ?? homedir();
  const config = environment.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  const parsed = JSON.parse(await readFile(join(config, 'cursor', 'auth.json'), 'utf8')) as { accessToken?: unknown };
  return typeof parsed.accessToken === 'string' && parsed.accessToken ? parsed.accessToken : undefined;
}

export async function cursorUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  const ask = async (): Promise<Response | undefined> => {
    const token = await cursorAccessToken(environment);
    if (!token) return undefined;
    return fetch('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    });
  };
  try {
    let response = await ask();
    if (response?.status === 401) {
      // An expired token: the CLI refreshes its own on `status`, then ask once more.
      const harness = localHarnessForCommand('cursor');
      if (harness) await captureNativeHarnessOutput(harness, ['status'], environment, PROBE_TIMEOUT_MS).catch(() => '');
      response = await ask();
    }
    return response?.ok ? cursorQuotaReading(await response.json()) : undefined;
  } catch {
    return undefined; // fail-open-ok: no figure beats a wrong one
  }
}

export const cursorUsageProbe = async (session: HarnessSession, environment: Environment): Promise<string | undefined> =>
  (await cursorUsageReading(session, environment))?.label;

// ---------------------------------------------------------------- Amp, Kilo

/** `amp usage`: `**Individual credits:** $9.36 remaining (…)`. */
export function ampUsageLabel(output: string): string | undefined {
  const amount = /credits:\**\s*\$([\d,]+(?:\.\d+)?)\s+remaining/i.exec(stripAnsi(output))?.[1];
  return amount === undefined ? undefined : balanceLabel(Number(amount.replace(/,/g, '')));
}

/** `kilo profile`: `Balance: $0.00`. */
export function kiloProfileLabel(output: string): string | undefined {
  const amount = /^Balance:\s*\$([\d,]+(?:\.\d+)?)/m.exec(stripAnsi(output))?.[1];
  return amount === undefined ? undefined : balanceLabel(Number(amount.replace(/,/g, '')));
}

async function captureLabel(command: string, argv: readonly string[], environment: Environment, parse: (output: string) => string | undefined): Promise<string | undefined> {
  try {
    const harness = localHarnessForCommand(command);
    return harness ? parse(await captureNativeHarnessOutput(harness, argv, environment, PROBE_TIMEOUT_MS)) : undefined;
  } catch { return undefined; } // fail-open-ok: no figure beats a wrong one
}

export const ampUsageProbe = (_session: HarnessSession, environment: Environment): Promise<string | undefined> =>
  captureLabel('amp', ['usage'], environment, ampUsageLabel);

export const kiloUsageProbe = (_session: HarnessSession, environment: Environment): Promise<string | undefined> =>
  captureLabel('kilo', ['profile'], environment, kiloProfileLabel);

export const copilotUsageProbe = async (session: HarnessSession, environment: Environment): Promise<string | undefined> =>
  (await copilotUsageReading(session, environment))?.label;

export const kimiUsageProbe = async (session: HarnessSession, environment: Environment): Promise<string | undefined> =>
  (await kimiUsageReading(session, environment))?.label;

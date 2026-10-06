/** Plan usage that more harnesses publish without a model turn, each
 * asked of the harness itself (its own credentials, its own token refresh):
 *
 *   - Auggie: `auggie account status --json` reports the credit balance.
 *   - Copilot: `copilot --headless --stdio` serves the Copilot SDK's JSON-RPC,
 *     whose `account.getQuota` answers the quota snapshots its TUI shows.
 *   - Kimi Code: `kimi web --no-open` serves `/api/v1/oauth/usage`, the same
 *     read its `/usage` makes (the 5h / 7d / monthly windows).
 *   - Amp: `amp usage` prints the account's credit balance.
 *   - Kilo: `kilo profile` prints the Kilo account's balance.
 *   - Cursor: the dashboard call its own usage screen makes
 *     (`DashboardService/GetCurrentPeriodUsage`), with the token the CLI
 *     keeps in ~/.config/cursor/auth.json. Verified 2026-09-30.
 *   - Kiro: its own `/usage`, run over ACP (`_kiro.dev/commands/execute`)
 *     on one kept session -- no turn. Verified on kiro-cli 2.23.1.
 *   - Command Code: `/alpha/billing/credits`, the call its `/usage` screen
 *     makes, with the key in ~/.commandcode/auth.json. Verified 2026-09-30.
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
import { acpDiscoverySession, queryAcp } from './acp-query.js';
import type { HarnessSession } from '../../session/model.js';
import { type UsageReading, type UsageWindow, usageReading, usageWindow } from './usage-reading.js';
import { planIsFree } from './free-plan.js';

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
  const quota = await contentLengthRequest(binary, ['--headless', '--no-auto-update', '--stdio'], environment, 'account.getQuota', {});
  const reading = copilotQuotaReading(quota);
  // Every paid Copilot plan has unlimited chat; only Copilot Free meters it
  // (200 a month), which is how its own quota answer tells them apart.
  const chat = (quota as Json | undefined)?.quotaSnapshots?.chat as Json | undefined;
  return reading && chat?.isUnlimitedEntitlement === false ? { ...reading, plan: { name: 'Copilot Free' } } : reading;
}

/** The models Copilot serves THIS account (`models.list` on its own
 * server): what its plan runs right now, where models.dev lists everything
 * Copilot offers anyone. A Free account with its chat spent lists `auto`
 * alone (2026-10-06), and that is the truth: nothing else would answer. */
export async function copilotAccountModels(environment: Environment): Promise<{ models: string[]; labels: Record<string, string> } | undefined> {
  const binary = await resolveBinaryPath(catalogBinary('copilot', 'copilot'));
  if (!binary) return undefined;
  const listed = (await contentLengthRequest(binary, ['--headless', '--no-auto-update', '--stdio'], environment, 'models.list', {}))?.models;
  if (!Array.isArray(listed)) return undefined;
  const labels: Record<string, string> = {};
  for (const model of listed as Json[]) if (typeof model?.id === 'string') labels[model.id] = typeof model.name === 'string' ? model.name : model.id;
  return Object.keys(labels).length ? { models: Object.keys(labels), labels } : undefined;
}

// ---------------------------------------------------------------- Antigravity

/** `fetchAvailableModels`' `quotaInfo` per model, as one window per quota
 * pool: models sharing a reset share a pool (Gemini's, and Claude's with
 * GPT-OSS, 2026-10-06), named by their families. A pool with no
 * `remainingFraction` is spent (a protobuf zero). Advisory: a turn answered
 * once while its pool read spent, and the refusal names the exact reset. */
export function antigravityQuotaReading(models: unknown): UsageReading | undefined {
  if (!models || typeof models !== 'object') return undefined;
  const pools = new Map<string, { families: Set<string>; left: number; reset: string }>();
  for (const [id, model] of Object.entries(models as Record<string, Json>)) {
    const quota = model?.quotaInfo as Json | undefined;
    if (typeof quota?.resetTime !== 'string' || typeof model.displayName !== 'string') continue;
    const left = typeof quota.remainingFraction === 'number' ? quota.remainingFraction : 0;
    const pool = pools.get(quota.resetTime) ?? { families: new Set<string>(), left, reset: quota.resetTime };
    pool.families.add((model.displayName as string).split(/\s+/)[0] ?? id);
    pool.left = Math.min(pool.left, left);
    pools.set(quota.resetTime, pool);
  }
  const windows = [...pools.values()].sort((a, b) => a.reset.localeCompare(b.reset)).map((pool) => {
    const window = usageWindow([...pool.families].join('/'), (1 - pool.left) * 100, pool.reset);
    return window ? { ...window, advisory: true as const } : undefined;
  });
  return usageReading(windows);
}

async function antigravityAccessToken(environment: Environment): Promise<string | undefined> {
  const file = join(environment.HOME ?? homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  const token = (JSON.parse(await readFile(file, 'utf8')) as Json).token as Json | undefined;
  const fresh = typeof token?.expiry === 'string' && Date.parse(token.expiry) > Date.now() + 60_000;
  return fresh && typeof token?.access_token === 'string' ? token.access_token : undefined;
}

/** The account's tier from `loadCodeAssist` ("free-tier") and its quota
 * pools from `fetchAvailableModels` for the project that answer names (sent
 * without it, every pool reads full). The token lasts an hour and only agy
 * renews it: `agy models` does, as it lists. */
export async function antigravityUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  try {
    let token = await antigravityAccessToken(environment).catch(() => undefined);
    if (!token) {
      const harness = localHarnessForCommand('antigravity');
      if (harness) await captureNativeHarnessOutput(harness, ['models'], environment, PROBE_TIMEOUT_MS).catch(() => '');
      token = await antigravityAccessToken(environment);
    }
    if (!token) return undefined;
    const ask = async (method: string, body: Json): Promise<Json | undefined> => {
      const response = await fetch(`https://cloudcode-pa.googleapis.com/v1internal:${method}`, {
        method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        // Any other client is told "This client is no longer supported".
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity/1.0.0' },
      });
      return response.ok ? await response.json() as Json : undefined;
    };
    const assist = await ask('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY', pluginType: 'GEMINI' } });
    const tier = assist?.currentTier?.id;
    const project = assist?.cloudaicompanionProject;
    if (typeof project !== 'string') return undefined;
    const reading = antigravityQuotaReading((await ask('fetchAvailableModels', { project }))?.models);
    return reading && typeof tier === 'string' ? { ...reading, plan: { name: tier } } : reading;
  } catch {
    return undefined; // fail-open-ok: no figure beats a wrong one
  }
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

/** A `GetCurrentPeriodUsage` answer as windows. The plan has two shares,
 * each resetting at `billingCycleEnd` (epoch ms): `autoPercentUsed`, spent by
 * Auto and the other `autoBucketModels` (ClikCode's default, `default[]`) --
 * at 100 their turns answer "You've hit your usage limit" -- and
 * `apiPercentUsed`, for named models only. `totalPercentUsed` is their
 * average (Auto 100 + API 0 read "50%"), so it is never the figure:
 * read once, it showed a spent account half full. */
export function cursorQuotaReading(result: unknown, planName?: string): UsageReading | undefined {
  const plan = (result as Json | undefined)?.planUsage as Json | undefined;
  if (!plan) return undefined;
  const end = Number((result as Json).billingCycleEnd);
  const reset = Number.isFinite(end) && end > 0 ? end : undefined;
  // A Free plan runs Auto only: every named model answers "Named models
  // unavailable. Free plans can only use Auto" (2026-10-06), so its API
  // share -- always "100% left" -- is no allowance at all.
  const api = planName === 'Free' ? undefined : usageWindow('API', plan.apiPercentUsed, reset);
  // A Free plan's agent usage is all bonus: with none left (`remainingBonus:
  // false`) its turns answer "Upgrade your plan to continue" even at 0% used
  // (GetPlanInfo "Free", 2026-10-06). A paid plan's included usage is not bonus.
  const auto = planName === 'Free' && plan.remainingBonus === false ? 100 : plan.autoPercentUsed ?? plan.totalPercentUsed;
  // The API share is advisory: spent, it stops named models, not Auto.
  return usageReading([usageWindow('auto', auto, reset), api ? { ...api, advisory: true as const } : undefined]);
}

/** `AiService/AvailableModels`: the models Cursor does not count as named. */
async function cursorUnnamedModels(environment: Environment): Promise<string[] | undefined> {
  const token = await cursorAccessToken(environment);
  if (!token) return undefined;
  const response = await fetch('https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels', {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
  });
  if (!response.ok) return undefined;
  const models = (await response.json() as Json).models;
  return Array.isArray(models) ? models.filter((model: Json) => model?.namedModelSectionIndex === undefined && typeof model?.name === 'string').map((model: Json) => model.name as string) : undefined;
}

async function cursorAccessToken(environment: Environment): Promise<string | undefined> {
  const home = environment.HOME ?? homedir();
  const config = environment.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  const parsed = JSON.parse(await readFile(join(config, 'cursor', 'auth.json'), 'utf8')) as { accessToken?: unknown };
  return typeof parsed.accessToken === 'string' && parsed.accessToken ? parsed.accessToken : undefined;
}

export async function cursorUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  const ask = async (method: string): Promise<Response | undefined> => {
    const token = await cursorAccessToken(environment);
    if (!token) return undefined;
    return fetch(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    });
  };
  try {
    let response = await ask('GetCurrentPeriodUsage');
    if (response?.status === 401) {
      // An expired token: the CLI refreshes its own on `status`, then ask once more.
      const harness = localHarnessForCommand('cursor');
      if (harness) await captureNativeHarnessOutput(harness, ['status'], environment, PROBE_TIMEOUT_MS).catch(() => '');
      response = await ask('GetCurrentPeriodUsage');
    }
    if (!response?.ok) return undefined;
    const plan = await ask('GetPlanInfo').then(async (answer) => answer?.ok ? (await answer.json() as Json).planInfo?.planName as string | undefined : undefined).catch(() => undefined);
    const reading = cursorQuotaReading(await response.json(), plan);
    if (!reading || !plan) return reading;
    // A Free plan runs only what Cursor does not file as a "named" model
    // (`namedModelSectionIndex`): Auto. Its refusal says the same, "Named
    // models unavailable. Free plans can only use Auto" (2026-10-06).
    const models = planIsFree({ name: plan }) ? await cursorUnnamedModels(environment).catch(() => undefined) : undefined;
    return { ...reading, plan: { name: plan, ...(models?.length ? { models } : {}) } };
  } catch {
    return undefined; // fail-open-ok: no figure beats a wrong one
  }
}

// ---------------------------------------------------------------- Cline

/** `GET /api/v1/users/{id}/balance` (cline 2.x's own fetchBalance): the
 * Cline account's credits in millionths of a dollar. At or below zero a paid
 * model answers "Insufficient balance. Your Cline Credits balance is $-0.20"
 * (-195907, 2026-10-06) while the `:free` models still answer -- checked on
 * all 12 accounts -- so spent credits are advisory, never a spent account
 * (catalog freePlan moves the turn to a free model). */
export function clineQuotaReading(result: unknown): UsageReading | undefined {
  const balance = Number(((result as Json | undefined)?.data as Json | undefined)?.balance);
  if (!Number.isFinite(balance)) return undefined;
  const dollars = balance / 1_000_000;
  if (dollars <= 0) return { windows: [{ name: 'credits', usedPct: 100, advisory: true }], label: 'Out of credits · free models only' };
  return { windows: [], label: `$${dollars.toFixed(2)} credits left` };
}

export async function clineUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  try {
    const home = environment.HOME ?? homedir();
    const providers = JSON.parse(await readFile(join(home, '.cline', 'data', 'settings', 'providers.json'), 'utf8')) as Json;
    // Signed in to a Cline account; a provider key of its own has no balance here.
    const auth = providers?.providers?.cline?.settings?.auth as Json | undefined;
    if (typeof auth?.accessToken !== 'string' || typeof auth.accountId !== 'string') return undefined;
    const response = await fetch(`https://api.cline.bot/api/v1/users/${encodeURIComponent(auth.accountId)}/balance`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok ? clineQuotaReading(await response.json()) : undefined;
  } catch {
    return undefined; // fail-open-ok: no figure beats a wrong one
  }
}

// ---------------------------------------------------------------- Mistral Vibe

/** Mistral's answer to a request with no messages, which its rate limiter
 * judges before anything runs (so it costs nothing): a key whose plan allows
 * no requests at all (`x-ratelimit-limit-req-minute: 0`, every Vibe key here
 * on 2026-10-06, though vibe itself reports it as a retryable 429) is spent.
 * Anything else says nothing about usage. */
export function vibeQuotaReading(status: number, requestsPerMinute: string | null): UsageReading | undefined {
  if (status === 429 && requestsPerMinute === '0') return { windows: [{ name: 'requests', usedPct: 100 }], label: 'No requests allowed on this plan' };
  return undefined;
}

export async function vibeUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  try {
    const home = environment.VIBE_HOME ?? join(environment.HOME ?? homedir(), '.vibe');
    const key = /^MISTRAL_API_KEY=["']?([^"'\s]+)/m.exec(await readFile(join(home, '.env'), 'utf8'))?.[1];
    if (!key) return undefined;
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-small-latest', messages: [] }),
    });
    await response.body?.cancel();
    return vibeQuotaReading(response.status, response.headers.get('x-ratelimit-limit-req-minute'));
  } catch {
    return undefined; // fail-open-ok: no figure beats a wrong one
  }
}

// ---------------------------------------------------------------- Devin

/** Windsurf's GetUserStatus `planStatus` (what devin's own CLI reads): a
 * daily and a weekly quota as percent remaining, each with its reset in unix
 * seconds (Free plan, 2026-10-06: daily 100, weekly 99). */
export function devinQuotaReading(planStatus: unknown): UsageReading | undefined {
  const plan = planStatus as Json | undefined;
  if (!plan) return undefined;
  const window = (name: string, remaining: unknown, reset: unknown): UsageWindow | undefined => {
    const left = Number(remaining);
    const at = Number(reset);
    return Number.isFinite(left) && remaining !== undefined ? usageWindow(name, 100 - left, Number.isFinite(at) && at > 0 ? at * 1000 : undefined) : undefined;
  };
  return usageReading([window('daily', plan.dailyQuotaRemainingPercent, plan.dailyQuotaResetAtUnix), window('weekly', plan.weeklyQuotaRemainingPercent, plan.weeklyQuotaResetAtUnix)]);
}

export async function devinUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  try {
    const data = environment.XDG_DATA_HOME ?? join(environment.HOME ?? homedir(), '.local', 'share');
    const credentials = await readFile(join(data, 'devin', 'credentials.toml'), 'utf8');
    const key = /^\s*windsurf_api_key\s*=\s*"([^"]+)"/m.exec(credentials)?.[1];
    const server = /^\s*api_server_url\s*=\s*"([^"]+)"/m.exec(credentials)?.[1] ?? 'https://server.codeium.com';
    if (!key) return undefined;
    // The full metadata: with only the key the server answers invalid_argument.
    const response = await fetch(`${server}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
      method: 'POST', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({ metadata: { apiKey: key, ideName: 'windsurf', ideVersion: '1.0.0', extensionName: 'windsurf', extensionVersion: '1.0.0' } }),
    });
    if (!response.ok) return undefined;
    const status = (await response.json() as Json).userStatus as Json | undefined;
    const reading = devinQuotaReading(status?.planStatus);
    const plan = status?.planStatus?.planInfo?.planName ?? status?.planInfo?.planName;
    return reading && typeof plan === 'string' ? { ...reading, plan: { name: plan } } : reading;
  } catch {
    return undefined; // fail-open-ok: no figure beats a wrong one
  }
}

// ---------------------------------------------------------------- Hermes (Nous Portal)

/** `GET /api/oauth/account` on the Nous Portal (hermes's own credit check):
 * the credits it can spend, and whether it may run paid models at all. */
export function hermesQuotaReading(account: unknown): UsageReading | undefined {
  const record = account as Json | undefined;
  const access = record?.paid_service_access as Json | undefined;
  if (!access) return undefined;
  const credits = Number(access.total_usable_credits ?? record?.purchased_credits_remaining);
  if (access.allowed === false) return { windows: [{ name: 'credits', usedPct: 100 }], label: 'Out of credits' };
  return Number.isFinite(credits) ? { windows: [], label: `$${credits.toFixed(2)} credits left` } : undefined;
}

export async function hermesUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  try {
    const home = environment.HERMES_HOME ?? join(environment.HOME ?? homedir(), '.hermes');
    const nous = ((JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')) as Json).providers as Json | undefined)?.nous as Json | undefined;
    // A short-lived token hermes renews as it runs; never renewed here.
    if (typeof nous?.access_token !== 'string') return undefined;
    const base = typeof nous.portal_base_url === 'string' ? nous.portal_base_url : 'https://portal.nousresearch.com';
    const response = await fetch(`${base}/api/oauth/account`, { headers: { Authorization: `Bearer ${nous.access_token}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.ok ? hermesQuotaReading(await response.json()) : undefined;
  } catch {
    return undefined; // fail-open-ok: no figure beats a wrong one
  }
}

// ---------------------------------------------------------------- Kiro

/** Kiro's `/usage` result: each `usageBreakdowns` entry a resource with a
 * limit (its plan credits), resetting on `billingCycleReset` (a date). */
export function kiroQuotaReading(data: unknown): UsageReading | undefined {
  const record = data as Json | undefined;
  const breakdowns: Json[] = Array.isArray(record?.usageBreakdowns) ? record!.usageBreakdowns : [];
  const credits = breakdowns.find((item) => item?.resourceType === 'CREDIT' && item.hasLimit !== false && Number(item.limit) > 0);
  if (!credits) return undefined;
  return usageReading([usageWindow('monthly', (Number(credits.used) / Number(credits.limit)) * 100, record?.billingCycleReset)]);
}

export async function kiroUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  const harness = localHarnessForCommand('kiro');
  if (!harness?.acp) return undefined;
  return queryAcp(harness.acp.binary ?? harness.binary, harness.acp.argv, environment, async (request, capabilities) => {
    // One kept session per Kiro profile, never a new one per reading.
    const started = await acpDiscoverySession(request, capabilities, `kiro:usage:${environment.HOME ?? 'default'}`);
    const sessionId = typeof started.sessionId === 'string' ? started.sessionId : undefined;
    if (!sessionId) return undefined;
    const answer = await request('_kiro.dev/commands/execute', { sessionId, command: { command: 'usage', args: {} } });
    if (answer.success === false) return undefined;
    const reading = kiroQuotaReading(answer.data);
    const plan = (answer.data as Json | undefined)?.planName;
    return reading && typeof plan === 'string' ? { ...reading, plan: { name: plan } } : reading;
  }, PROBE_TIMEOUT_MS).catch(() => undefined);
}

// ---------------------------------------------------------------- Command Code

/** `/alpha/billing/credits`: the plan's 5-hour and weekly windows when it has
 * them (`windowLimits.limited`, each `{used, cap, resetAt}`), else the credit
 * balance. A balance is not a window, so it never marks the account spent. */
export function commandCodeQuotaReading(result: unknown): UsageReading | undefined {
  const record = result as Json | undefined;
  const limits = record?.windowLimits as Json | undefined;
  const window = (name: string, entry: Json | undefined): UsageWindow | undefined =>
    entry && Number(entry.cap) > 0 ? usageWindow(name, (Number(entry.used) / Number(entry.cap)) * 100, entry.resetAt) : undefined;
  const windows = limits?.limited ? usageReading([window('5h', limits.fiveHour), window('weekly', limits.weekly)]) : undefined;
  if (windows) return windows;
  const credits = record?.credits as Json | undefined;
  const balance = ['monthlyCredits', 'purchasedCredits', 'freeCredits'].reduce((sum, key) => sum + (Number(credits?.[key]) || 0), 0);
  // None left is spent: its turns answer "Insufficient credits for Command
  // Code" (2026-10-06), until a reading shows credits again.
  if (credits && balance <= 0) return { windows: [{ name: 'credits', usedPct: 100 }], label: 'Out of credits' };
  return balance > 0 ? { windows: [], label: `${Number.isInteger(balance) ? balance : balance.toFixed(2)} credits left` } : undefined;
}

export async function commandCodeUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  try {
    const home = environment.HOME ?? homedir();
    const auth = JSON.parse(await readFile(join(home, '.commandcode', 'auth.json'), 'utf8')) as { apiKey?: unknown };
    if (typeof auth.apiKey !== 'string' || !auth.apiKey) return undefined;
    const response = await fetch('https://api.commandcode.ai/alpha/billing/credits', {
      headers: { Authorization: `Bearer ${auth.apiKey}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok ? commandCodeQuotaReading(await response.json()) : undefined;
  } catch {
    return undefined; // fail-open-ok: no figure beats a wrong one
  }
}

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

/** `auggie account status --json`, verified against a real account:
 * `{"planName":"Free Plan","usageUnit":"usd","amountRemaining":"0",...}`.
 * The amount arrives as a string; one that does not parse is not guessed at.
 * Spent is said in the words every harness uses for it. */
export function auggieUsageLabel(raw: string): string | undefined {
  let status: { usageUnit?: unknown; amountRemaining?: unknown };
  try { status = JSON.parse(raw) as typeof status; } catch { return undefined; }
  const value = status.amountRemaining;
  const remaining = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(remaining)) return undefined;
  if (remaining <= 0) return 'Out Of Credits';
  const unit = typeof status.usageUnit === 'string' ? status.usageUnit : undefined;
  if (unit?.toLowerCase() === 'usd') return balanceLabel(remaining);
  return `${Number.isInteger(remaining) ? remaining : remaining.toFixed(2)}${unit ? ` ${unit}` : ''} credits left`;
}

export async function auggieUsageReading(_session: HarnessSession, environment: Environment): Promise<UsageReading | undefined> {
  let raw: string;
  try {
    const harness = localHarnessForCommand('auggie');
    if (!harness) return undefined;
    raw = await captureNativeHarnessOutput(harness, ['account', 'status', '--json'], environment, PROBE_TIMEOUT_MS);
  } catch { return undefined; } // fail-open-ok: no figure beats a wrong one
  const label = auggieUsageLabel(raw);
  if (label === undefined) return undefined;
  let plan: unknown;
  try { plan = (JSON.parse(raw) as Json).planName; } catch { /* the label already parsed it */ }
  return { windows: [], label, ...(typeof plan === 'string' && plan ? { plan: { name: plan } } : {}) };
}

export const ampUsageProbe = (_session: HarnessSession, environment: Environment): Promise<string | undefined> =>
  captureLabel('amp', ['usage'], environment, ampUsageLabel);

export const kiloUsageProbe = (_session: HarnessSession, environment: Environment): Promise<string | undefined> =>
  captureLabel('kilo', ['profile'], environment, kiloProfileLabel);


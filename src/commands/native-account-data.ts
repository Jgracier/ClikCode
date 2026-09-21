/** Per-account native data derivation: model catalogs (discovered live via
 * a harness's own CLI where one exists, hardcoded only where verified and
 * genuinely stable) and usage/quota probes (reading a vendor's own
 * credential file or calling its real API with the account's own token).
 * Nothing here is guessed -- every hardcoded value and every probe was
 * checked against a real installed CLI or a real API response. */

import { spawnPortable as spawn, terminatePortable } from './spawn-portable.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { captureNativeHarnessOutput } from './native-harness.js';
import { readState, writeState } from './harness-state.js';
import { localHarnessForCommand, localHarnessForProvider, nativeProfileEnvironment } from './native-harness-protocol.js';
import { CLI_VERSION } from '../cli/program-base.js';
import type {
  AiHarnessAccount, AiLocalHarnessDefinition, HarnessSession, HarnessState, ModelCatalogResult, NativeUsageProbe,
} from './types.js';





/**
 * Claude Code's `--model` aliases are deliberately version-less — they always
 * track whatever Anthropic currently ships for that tier, so passing the bare
 * alias (not a dated id) is the correct, future-proof argv value. That leaves
 * the alias alone unreadable in a picker ("sonnet" looks stale next to
 * "Sonnet 5"), so this is display-only: which concrete generation each alias
 * currently resolves to, verified against a real `claude --model <alias>
 * --output-format stream-json` run's `system.init.model` field. Update when
 * Anthropic ships a new tier — same manual-maintenance shape as the Copilot
 * model list a few lines below.
 */
export const CLAUDE_ALIAS_LABELS: Readonly<Record<string, string>> = {
  fable: 'Fable 5.1', opus: 'Opus 5', sonnet: 'Sonnet 5', haiku: 'Haiku 4.5',
};

/** Provider-specific model naming belongs to account metadata, not generic
 * session pickers or terminal renderers. Unknown models always pass through. */
export function nativeModelLabel(
  harnessCommand: string | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!model) return undefined;
  return harnessCommand === 'claude' ? CLAUDE_ALIAS_LABELS[model] ?? model : model;
}

// Model lists change even less often than installation status -- 5 minutes
// is conservative, not aggressive. Without this, every single /model open
// re-ran a real subprocess (harness.modelDiscoveryArgv) with up to a
// 12-second timeout for any harness that declares one (opencode, several
// others) -- on top of inspectNativeHarness's own cost this stacked into
// exactly the "options are still slow" report, in a second picker beyond
// /provider.
export const modelCatalogCache = new Map<string, { at: number; result: ModelCatalogResult }>();
export const MODEL_CATALOG_CACHE_TTL_MS = 300_000;

/** Choice lists use cached/local metadata synchronously and refresh discovery
 * after their first frame. They must not wait on a vendor subprocess. */
export function nativeModelCatalogForPicker(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): ModelCatalogResult {
  const cacheKey = `${harness.command}:${account?.nativeProfile?.path ?? account?.id ?? 'default'}`;
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MODEL_CATALOG_CACHE_TTL_MS) return cached.result;
  void nativeModelCatalog(harness, account).catch(() => undefined);
  return { models: [...new Set(account?.models ?? [])] };
}

export async function nativeModelCatalog(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): Promise<ModelCatalogResult> {
  const cacheKey = `${harness.command}:${account?.nativeProfile?.path ?? account?.id ?? 'default'}`;
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MODEL_CATALOG_CACHE_TTL_MS) return cached.result;
  const result = await nativeModelCatalogUncached(harness, account);
  modelCatalogCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

export async function nativeModelCatalogUncached(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): Promise<ModelCatalogResult> {
  const models = new Set(account?.models ?? []);
  const addDiscoveredModels = (raw: string): void => {
    const add = (value: unknown): void => {
      if (typeof value !== 'string') return;
      const model = value.trim();
      if (/^[a-z0-9][a-z0-9._:/-]{1,127}$/i.test(model)) models.add(model);
    };
    try {
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (/^(?:id|model|modelId|slug)$/i.test(key)) add(child);
          else visit(child);
        }
      };
      visit(JSON.parse(raw));
    } catch {
      for (const line of raw.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)) {
        const clean = line.trim().replace(/^[•*✓✔❯>\-]+\s*/, '');
        if (!clean) continue;
        const token = clean.split(/\s+/, 1)[0]?.replace(/^['"`]|['"`,:]$/g, '');
        if (token && (clean === token || /[\/.\d:_-]/.test(token))) add(token);
      }
    }
  };
  const profileRoot = account?.nativeProfile?.path
    ?? (harness.profileEnv ? process.env[harness.profileEnv]?.trim() : undefined)
    ?? (harness.command === 'codex' ? join(homedir(), '.codex')
      : harness.command === 'claude' ? join(homedir(), '.claude') : undefined);
  let configured: string | undefined;
  if (profileRoot && harness.command === 'codex') {
    try {
      const config = await readFile(join(profileRoot, 'config.toml'), 'utf8');
      configured = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim();
    } catch { /* Codex will choose its own default when no config exists. */ }
    try {
      const cache = JSON.parse(await readFile(join(profileRoot, 'models_cache.json'), 'utf8')) as { models?: Array<{ slug?: unknown; visibility?: unknown }> };
      for (const model of cache.models ?? []) {
        if (typeof model.slug === 'string' && model.slug.trim() && model.visibility !== 'hide') models.add(model.slug.trim());
      }
    } catch { /* The cache is optional and vendor-owned. */ }
  } else if (profileRoot && harness.command === 'claude') {
    try {
      const settings = JSON.parse(await readFile(join(profileRoot, 'settings.json'), 'utf8')) as { model?: unknown };
      if (typeof settings.model === 'string' && settings.model.trim()) configured = settings.model.trim();
    } catch { /* Claude will choose its own default when no setting exists. */ }
    ['fable', 'opus', 'sonnet', 'haiku'].forEach((model) => models.add(model));
  }
  // Copilot had the same problem, worse: a full hardcoded model list with
  // no discovery mechanism and no verification against Copilot CLI itself
  // ever performed -- checked its own GitHub issue tracker directly
  // (github/copilot-cli#700, #1356, #236), which confirms this is a known,
  // still-open gap in Copilot CLI itself: there is no `copilot models`
  // command, only an interactive picker with no scriptable equivalent.
  // Removed rather than kept as a guess.
  if (harness.modelDiscoveryArgv) {
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    try {
      addDiscoveredModels(await captureNativeHarnessOutput(harness, harness.modelDiscoveryArgv, environment, 12_000));
    } catch { /* Keep configured/account models and the custom-ID option available. */ }
  }
  if (configured) models.add(configured);
  return {
    ...(configured ? { configured } : {}),
    models: [...models],
    ...(harness.command === 'claude' ? { labels: CLAUDE_ALIAS_LABELS } : {}),
  };
}

/** One quota window as the vendor reported it. `usedPct` is the unrounded
 * percentage used (0..100+); the display label rounds, this does not, so
 * "99.6% used" is never mistaken for exhausted. */
export interface UsageWindow { name: string; usedPct: number; resetsAt?: string }
/** A usage reading: the structured windows plus the label the UI shows. */
export interface UsageReading { windows: UsageWindow[]; label?: string }
/** What is stored on `account.usage`. `windows` is persisted alongside the
 * typed fields; types.ts only declares `at`/`label`/`failed` today. */
export type AccountUsageReading = NonNullable<AiHarnessAccount['usage']> & { windows?: UsageWindow[] };
interface UsageCacheEntry { at: number; label?: string; failed?: boolean; windows?: UsageWindow[] }

export const nativeUsageCache = new Map<string, UsageCacheEntry>();

/** One key for every path that produces or reads a usage figure. The stream
 * reader used `harness:nativeSessionId` while the probe used
 * `harness:profilePath`, so a free reading taken during a turn never satisfied
 * the next paint, which then paid for a probe anyway. Usage belongs to the
 * account; a session is only the fallback when there is no account. */
export function usageCacheKey(harnessCommand: string | undefined, accountId: string | null | undefined, nativeSessionId?: string): string {
  return accountId ? `${harnessCommand}:account:${accountId}` : `${harnessCommand}:session:${nativeSessionId ?? 'default'}`;
}

function resetTime(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Vendors publish epoch seconds; tolerate milliseconds.
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return undefined;
}

function usageWindow(name: string, usedPct: unknown, resetsAt?: unknown): UsageWindow | undefined {
  if (typeof usedPct !== 'number' || !Number.isFinite(usedPct)) return undefined;
  const reset = resetTime(resetsAt);
  return { name, usedPct, ...(reset ? { resetsAt: reset } : {}) };
}

/** The single wording for a set of windows, whichever path produced them. */
export function usageReadingLabel(windows: readonly UsageWindow[]): string | undefined {
  const parts = windows.map((window) => `${window.name} ${Math.max(0, Math.min(100, Math.round(100 - window.usedPct)))}% left`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** "resets at 8:00PM", derived from the same vendor-reported `resetsAt` the
 * usage windows already carry -- not computed independently. Only speaks for
 * a window that is actually exhausted right now (matches accountIsExhausted's
 * `usedPct >= 100` threshold) and whose reset is still ahead of us; picks the
 * soonest one when more than one window is spent. */
export function usageResetLabel(windows: readonly UsageWindow[] | undefined, now: number = Date.now()): string | undefined {
  const exhausted = (windows ?? [])
    .filter((window): window is UsageWindow & { resetsAt: string } => window.usedPct >= 100 && window.resetsAt !== undefined && Date.parse(window.resetsAt) > now)
    .sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
  const next = exhausted[0];
  if (!next) return undefined;
  const date = new Date(next.resetsAt);
  const hours24 = date.getHours();
  const period = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `resets at ${hours12}:${minutes}${period}`;
}

function usageReading(windows: Array<UsageWindow | undefined>): UsageReading | undefined {
  const known = windows.filter((window): window is UsageWindow => Boolean(window));
  return known.length ? { windows: known, label: usageReadingLabel(known) } : undefined;
}

/** A figure describes a window; once that window has reset it describes
 * nothing, and showing it would present last period's quota as current. */
export function usageReadingIsCurrent(reading: { windows?: readonly UsageWindow[] } | undefined, now = Date.now()): boolean {
  return !(reading?.windows ?? []).some((window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now);
}

/** Is this account out of quota right now?
 *
 * Decided on the unrounded `usedPct >= 100`, never on the display string
 * ("0% left" is also what 99.6% used rounds to). Clears itself once every
 * exhausted window's `resetsAt` has passed, so an account is not left parked
 * after its quota came back. A failover-recorded `quotaState: 'exhausted'`
 * holds when no structured reading exists to say otherwise. */
export function accountIsExhausted(account: AiHarnessAccount, now: number = Date.now()): boolean {
  const windows = (account.usage as AccountUsageReading | undefined)?.windows ?? [];
  const spent = windows.filter((window) => window.usedPct >= 100);
  const stillSpent = spent.filter((window) => window.resetsAt === undefined || Date.parse(window.resetsAt) > now);
  if (stillSpent.length) return true;
  if (account.quotaState !== 'exhausted') return false;
  // Marked exhausted by a failed turn. A window that was spent and has since
  // reset is the trustworthy signal that the mark is obsolete.
  return spent.length === 0;
}
/** Two readings a minute, per ACCOUNT rather than per chat. The rate that
 * matters is accounts-in-use divided by this window: the reading now lives on
 * the account record, so any number of open chats on one login still costs one
 * request per window. It was per process before, which multiplied by every
 * open terminal and is what rate-limited the account out of reading its own
 * usage. The poll interval below divides this, so a tick actually probes
 * instead of landing inside the previous window. */

/** The Claude probe runs a real (tiny) turn, so it waits on the model, not on
 * a local file: measured at ~1.7s to the rate_limit_event, with room for a
 * slow link. The other probes read locally and use a tighter 8s. */
const NATIVE_USAGE_PROBE_TIMEOUT_MS = 20_000;

/** Per-harness live usage probe. Each vendor CLI exposes quota/cost through a different
 * surface (or none at all); adding a harness here is the only step needed to light up
 * its usage footer, everything else (caching, dispatch, rendering) is shared. */

/** The executable the catalog declares for a harness (`harness.binary`), never a
 * name assumed from the command: forks and renamed installs differ. */
function harnessBinary(command: string, fallback: string = command): string {
  try {
    return localHarnessForCommand(command)?.binary ?? fallback;
  } catch {
    // fail-open-ok: the catalog runtime is unavailable; the documented default binary name is the best remaining answer.
    return fallback;
  }
}

/** A probe that failed produced no value, so there is nothing here to go
 * stale -- this is a backoff on a failing call, not a cached reading. Without
 * it an offline or broken probe is re-run on every repaint, and for a harness
 * whose probe is a real turn that is expensive as well as useless. */
const NATIVE_USAGE_FAILURE_TTL_MS = 60_000;

/** Usage is a percentage of a quota window, or it is nothing.
 *
 * OpenCode's probe used to return a token count and a dollar figure here
 * ("10K tok · $0.42"), which is a different quantity wearing the same label:
 * it says how much a conversation cost, not how much of an allowance is left.
 * Two harnesses reporting in two units cannot be compared in an account
 * picker, and a number that never approaches a limit cannot drive failover.
 * A harness that publishes no window publishes no usage.
 */
export async function codexUsageProbe(session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<string | undefined> {
  return (await codexUsageReading(session, environment))?.label;
}

export async function codexUsageReading(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<UsageReading | undefined> {
  const binary = harnessBinary('codex');
  const response = await new Promise<Record<string, unknown> | undefined>((resolveUsage) => {
    const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...environment },
    });
    let buffer = '';
    let settled = false;
    let initialized = false;
    const finish = (value?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminatePortable(child);
      resolveUsage(value);
    };
    const send = (message: Record<string, unknown>): void => {
      if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: unknown };
          if (message.id === 1 && message.result && typeof message.result === 'object') {
            if (initialized) return;
            initialized = true;
            // The rate-limits read answers only after the initialize handshake has
            // settled; give the transport a moment before asking, and leave stdin
            // open so the response can come back.
            const ask = setTimeout(() => send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } }), 250);
            ask.unref();
          } else if (message.id === 2 && message.result && typeof message.result === 'object') {
            return finish(message.result as Record<string, unknown>);
          }
        } catch { /* Ignore logs and unrelated notifications. */ }
      }
    });
    child.once('error', () => finish());
    child.once('exit', () => finish());
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'clikcode', version: CLI_VERSION } } });
    send({ method: 'initialized', params: {} });
    const timer = setTimeout(() => finish(), 8_000);
    timer.unref();
  });
  return codexRateLimitsReading(response?.rateLimits);
}

/** Claude Code's quota, asked of Claude Code, for one specific account.
 *
 * The CLI exposes no usage flag or subcommand (checked: `claude --help` lists
 * agents/attach/auth/auto-mode/doctor/gateway/import/install/logs/mcp/plugin
 * and nothing for usage). What it does do is report both windows on the turn
 * stream, so the probe is the smallest possible turn -- and because it runs
 * under this account's own CLAUDE_CONFIG_DIR, the figure is that account's,
 * not whichever one happens to own ~/.claude.
 *
 * Measured against the live CLI: `system` at +0.6s, `assistant` and
 * `rate_limit_event` together at +1.7s. The event lands after the model has
 * already answered, so stopping early saves nothing -- the child is killed
 * once the figure is in hand purely to avoid waiting on teardown.
 *
 * This costs a token round-trip to measure a token budget, which is why only
 * an explicit request runs it: opening the account picker, or `/usage`. Every
 * ordinary paint reads what the last real turn already reported.
 */
export async function claudeUsageProbe(session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<string | undefined> {
  return (await claudeUsageReading(session, environment))?.label;
}

export async function claudeUsageReading(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<UsageReading | undefined> {
  const binary = harnessBinary('claude');
  return new Promise<UsageReading | undefined>((resolveUsage) => {
    const child = spawn(binary, ['-p', 'hi', '--verbose', '--output-format', 'stream-json'], {
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...environment },
    });
    let buffer = '';
    let settled = false;
    const finish = (value?: UsageReading): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminatePortable(child);
      resolveUsage(value);
    };
    const timer = setTimeout(() => finish(), NATIVE_USAGE_PROBE_TIMEOUT_MS);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const reading = claudeStreamReading(line);
        if (reading?.label) { finish(reading); return; }
        newline = buffer.indexOf('\n');
      }
    });
    // fail-open-ok: a probe that cannot run reports no figure. Usage is
    // decoration and must never block or fail a turn.
    child.once('error', () => finish());
    child.once('exit', () => finish());
  });
}

/** Claude Code reports both quota windows on its own stream-json output, on
 * every turn (confirmed live):
 *
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
 *     "unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":...},
 *                       "seven_day":{"utilization":0.04,"resetsAt":...}}}}
 *
 * This is the only source for Claude Code's quota. It used to be a faster
 * second path beside an authenticated call to the vendor's own usage
 * endpoint; that call is gone, and not only on principle -- the endpoint is a
 * per-ACCOUNT budget, and several open chats polling it exhausted it between
 * them, which is what put "usage rate limited" in the status bar.
 * Utilization here is a 0..1 fraction, where the endpoint used 0..100. */
function claudeStreamReading(lineText: string): UsageReading | undefined {
  if (!lineText.includes('rate_limit_event')) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(lineText); } catch {
    // fail-open-ok: one unparseable line on an optional decoration path. The
    // turn's own output is read elsewhere and is unaffected.
    return undefined;
  }
  const record = parsed as {
    type?: unknown;
    rate_limit_info?: { unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown; resets_at?: unknown } | undefined> };
  };
  if (record.type !== 'rate_limit_event') return undefined;
  const windows = record.rate_limit_info?.unifiedWindows;
  if (!windows) return undefined;
  const window = (name: string, value?: { utilization?: unknown; resetsAt?: unknown; resets_at?: unknown }): UsageWindow | undefined =>
    usageWindow(name, typeof value?.utilization === 'number' ? value.utilization * 100 : undefined, value?.resetsAt ?? value?.resets_at);
  return usageReading([window('5h', windows.five_hour), window('weekly', windows.seven_day)]);
}

function claudeStreamUsage(lineText: string): string | undefined {
  return claudeStreamReading(lineText)?.label;
}

/** Vendors describe a quota window by its length, not by a name. 300 minutes
 * and 10080 minutes are the two everyone actually uses, and naming them the
 * way the endpoint probe already does keeps one wording for one account no
 * matter which path produced the reading. */
export function usageWindowName(minutes: number): string {
  if (minutes === 10_080) return 'weekly';
  if (minutes === 1_440) return 'daily';
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Codex pushes account/rateLimits/updated on its app-server connection during
 * a turn, unprompted (confirmed live). Reading it there replaces codexUsageProbe
 * spawning an ENTIRE SECOND `codex app-server` process -- handshake, a 250ms
 * settle, one request, teardown -- on every refresh, per account, per terminal.
 * usedPercent here is already a percent, unlike Claude's 0..1 fraction. */
export function codexRateLimitsReading(rateLimits: unknown): UsageReading | undefined {
  type Window = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown; resetsInSeconds?: unknown };
  const windows = rateLimits && typeof rateLimits === 'object' ? rateLimits as { primary?: Window; secondary?: Window } : undefined;
  const part = (window?: Window): UsageWindow | undefined => {
    if (typeof window?.usedPercent !== 'number' || typeof window.windowDurationMins !== 'number') return undefined;
    const resetsAt = window.resetsAt ?? (typeof window.resetsInSeconds === 'number' ? Date.now() + window.resetsInSeconds * 1000 : undefined);
    return usageWindow(usageWindowName(window.windowDurationMins), window.usedPercent, resetsAt);
  };
  return usageReading([part(windows?.primary), part(windows?.secondary)]);
}

/** Label form, for callers that still pass a string to recordDerivedUsage. The
 * structured reading behind the label is remembered briefly so that path keeps
 * `usedPct`/`resetsAt` too; passing codexRateLimitsReading() directly is better. */
const recentReadingByLabel = new Map<string, UsageReading>();
export function codexRateLimitsLabel(rateLimits: unknown): string | undefined {
  const reading = codexRateLimitsReading(rateLimits);
  if (reading?.label) {
    recentReadingByLabel.delete(reading.label);
    recentReadingByLabel.set(reading.label, reading);
    if (recentReadingByLabel.size > 8) recentReadingByLabel.delete(recentReadingByLabel.keys().next().value as string);
  }
  return reading?.label;
}

/** Quota a harness reports on its own stream, recognised by the SHAPE of the
 * record rather than by which harness sent it.
 *
 * A harness that is being driven is the authority on its own quota: it knows
 * what it just spent, and it says so for free on the stream already being
 * parsed. Keying that by harness name meant every new vendor started out
 * unable to report something it was already reporting, and pushed the ones
 * without an entry onto an HTTP endpoint instead -- a per-account budget that
 * several open terminals exhaust between them.
 *
 * Two shapes cover every vendor seen so far, and an unknown record simply
 * matches neither:
 *   - `rate_limit_event.rate_limit_info.unifiedWindows` (Claude Code), whose
 *     utilization is a 0..1 fraction;
 *   - a `rate_limits` object with `primary`/`secondary` windows (Codex, and
 *     anything else carrying the app-server's shape), in 0..100 percent. */
export function streamQuotaReading(value: unknown): UsageReading | undefined {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  if (!record) return undefined;
  const info = record.rate_limit_info ?? record.rateLimitInfo;
  const unified = info && typeof info === 'object'
    ? (info as { unifiedWindows?: unknown; unified_windows?: unknown }).unifiedWindows
      ?? (info as { unified_windows?: unknown }).unified_windows
    : undefined;
  if (unified && typeof unified === 'object') {
    const windows = unified as Record<string, { utilization?: unknown; resetsAt?: unknown; resets_at?: unknown } | undefined>;
    const window = (name: string, key: string): UsageWindow | undefined => {
      const entry = windows[key];
      return usageWindow(
        name, typeof entry?.utilization === 'number' ? entry.utilization * 100 : undefined,
        entry?.resetsAt ?? entry?.resets_at,
      );
    };
    return usageReading([window('5h', 'five_hour'), window('weekly', 'seven_day')]);
  }
  return codexRateLimitsReading(record.rate_limits ?? record.rateLimits);
}

/** Read a stream line for quota, whatever harness produced it. */
export function streamQuotaReadingFromLine(lineText: string): UsageReading | undefined {
  // Self-gated: ordinary output lines are not re-parsed as JSON.
  if (!lineText.includes('rate_limit') && !lineText.includes('rateLimit')) return undefined;
  try {
    return streamQuotaReading(JSON.parse(lineText));
  } catch {
    // fail-open-ok: one unparseable line on a decoration path. The turn's own
    // output is read elsewhere and is unaffected.
    return undefined;
  }
}

/** Harnesses whose quota arrives on their turn stream. Every harness is read
 * by shape, so this says "this one reports for itself", nothing more: it is
 * what tells the caller not to ask an endpoint for what the harness gives. */
export const NATIVE_STREAM_USAGE: Readonly<Partial<Record<string, (lineText: string) => string | undefined>>> = {
  claude: claudeStreamUsage,
};

/** Structured counterpart of NATIVE_STREAM_USAGE. */
export const NATIVE_STREAM_USAGE_READINGS: Readonly<Partial<Record<string, (lineText: string) => UsageReading | undefined>>> = {
  claude: claudeStreamReading,
};

function accountUsageFrom(entry: UsageCacheEntry): AccountUsageReading {
  return {
    at: new Date(entry.at).toISOString(),
    ...(entry.label === undefined ? {} : { label: entry.label }),
    ...(entry.failed ? { failed: true } : {}),
    ...(entry.windows?.length ? { windows: entry.windows } : {}),
  };
}

/** Publish a reading onto the account so every terminal sees it, and into the
 * in-process cache so this terminal's next paint does not re-probe. */
async function publishUsageReading(cacheKey: string, accountId: string | null | undefined, reading: UsageReading): Promise<void> {
  const entry: UsageCacheEntry = { at: Date.now(), ...(reading.label === undefined ? {} : { label: reading.label }), ...(reading.windows.length ? { windows: reading.windows } : {}) };
  nativeUsageCache.set(cacheKey, entry);
  if (!accountId) return;
  const state = await readState();
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;
  account.usage = accountUsageFrom(entry);
  // writeState merges usage by newest `at`, so this cannot disturb another
  // terminal or be reverted by one holding an older snapshot.
  await writeState(state).catch(() => undefined);
}

/** Read usage off a turn's own output line, if this harness reports it there.
 * A reading taken this way costs nothing and refreshes on every turn, so the
 * endpoint probe is left to cover only the cold start: a terminal that has not
 * run a turn yet has no stream to read. */
export async function recordNativeStreamUsage(session: HarnessSession, lineText: string): Promise<string | undefined> {
  if (!session.nativeHarness) return undefined;
  // By shape first, so a harness reporting quota in a known form is read
  // whether or not anyone has registered it by name.
  const structured = streamQuotaReadingFromLine(lineText)
    ?? NATIVE_STREAM_USAGE_READINGS[session.nativeHarness]?.(lineText);
  return recordDerivedUsage(session, structured ?? NATIVE_STREAM_USAGE[session.nativeHarness]?.(lineText));
}

/** Publish a reading the harness gave us for free during a turn, from whichever
 * transport it arrived on -- a stdout line, or an app-server notification.
 * Accepts a structured reading (preferred) or just its label. */
export async function recordDerivedUsage(session: HarnessSession, usage: string | UsageReading | undefined): Promise<string | undefined> {
  if (!usage) return undefined;
  const reading: UsageReading = typeof usage === 'string' ? recentReadingByLabel.get(usage) ?? { windows: [], label: usage } : usage;
  if (!reading.label) return undefined;
  const cacheKey = usageCacheKey(session.nativeHarness, session.accountId, session.nativeSessionId);
  await publishUsageReading(cacheKey, session.accountId, reading).catch(() => undefined);
  return reading.label;
}

export const NATIVE_USAGE_PROBES: Readonly<Partial<Record<string, NativeUsageProbe>>> = {
  codex: codexUsageProbe,
  claude: claudeUsageProbe,
};

export type NativeUsageReadingProbe = (session: HarnessSession, environment: Readonly<Record<string, string>>) => Promise<UsageReading | undefined>;
/** Structured probes for the harnesses whose label probe above is the built-in
 * one. A probe registered only in NATIVE_USAGE_PROBES still works; it simply
 * yields a label without windows. */
export const NATIVE_USAGE_READING_PROBES: Readonly<Partial<Record<string, { label: NativeUsageProbe; reading: NativeUsageReadingProbe }>>> = {
  codex: { label: codexUsageProbe, reading: codexUsageReading },
  claude: { label: claudeUsageProbe, reading: claudeUsageReading },
};

/** The structured reading behind nativeUsageLabel: same caching, same sharing. */
export async function nativeUsageReading(
  session: HarnessSession, state: HarnessState, options: { network?: boolean } = {},
): Promise<UsageReading | undefined> {
  const probe = session.nativeHarness ? NATIVE_USAGE_PROBES[session.nativeHarness] : undefined;
  // A harness that reports on its own turn stream has a usage source even with
  // no probe behind it, and its readings are already in the cache below. This
  // gate used to be `if (!probe) return undefined`, which meant removing a
  // probe also made every reading that harness had already given unreadable.
  const reportsOnStream = session.nativeHarness ? NATIVE_STREAM_USAGE_READINGS[session.nativeHarness] !== undefined : false;
  if (!probe && !reportsOnStream) return undefined;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const cacheKey = usageCacheKey(session.nativeHarness, account?.id, session.nativeSessionId);
  const cached = nativeUsageCache.get(cacheKey);
  // The account's own record is the shared reading: every terminal sees it, so
  // the cost of displaying usage no longer multiplies by the number of open
  // chats. The in-process map stays in front of it as a fast path for repeated
  // paints within one terminal.
  const shared = account?.usage as AccountUsageReading | undefined;
  const sharedEntry: UsageCacheEntry | undefined = shared && {
    at: Date.parse(shared.at), ...(shared.label === undefined ? {} : { label: shared.label }),
    ...(shared.failed ? { failed: true } : {}), ...(shared.windows?.length ? { windows: shared.windows } : {}),
  };
  // Whichever is newer: another terminal may have published since this
  // process last cached.
  const entry = cached && sharedEntry ? (sharedEntry.at > cached.at ? sharedEntry : cached) : cached ?? sharedEntry;
  // Usage is not cached. These numbers move while nobody is looking -- a turn
  // runs on the same account somewhere else, a window rolls over -- so there
  // is no time-based memo here deciding that a figure is still good enough.
  //
  // What IS reused is the harness's own last report, and only for exactly as
  // long as that report says it is true: a reading carries the resetsAt of
  // every window it describes, and is dropped the moment the soonest one
  // passes. That is the value's own stated validity, not an interval this
  // code invented. A reading with no window cannot make that claim, so it is
  // never reused at all -- which is what let "usage rate limited", a label
  // with nothing in it to expire, sit in the status line for the life of the
  // process.
  //
  // An explicit ask (`/usage`, the account picker) always goes to the
  // harness, because the point of asking is to find out now.
  // A failed probe is held off briefly -- see NATIVE_USAGE_FAILURE_TTL_MS.
  // That is not a cached figure; there is no figure.
  if (entry?.failed && Number.isFinite(entry.at) && Date.now() - entry.at < NATIVE_USAGE_FAILURE_TTL_MS && !options.network) {
    return entry.label === undefined ? undefined : { windows: entry.windows ?? [], label: entry.label };
  }
  const reusable = entry && !entry.failed && (entry.windows?.length ?? 0) > 0 && usageReadingIsCurrent(entry)
    ? entry
    : undefined;
  if (reusable && !options.network) {
    nativeUsageCache.set(cacheKey, reusable);
    return { windows: reusable.windows ?? [], ...(reusable.label === undefined ? {} : { label: reusable.label }) };
  }
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const structured = session.nativeHarness ? NATIVE_USAGE_READING_PROBES[session.nativeHarness] : undefined;
  const reading: UsageReading | undefined = !probe
    ? undefined
    : structured && structured.label === probe
      ? await structured.reading(session, environment).catch(() => undefined)
      : await probe(session, environment).then((label) => (label === undefined ? undefined : { windows: [], label })).catch(() => undefined);
  // Carry the last known figure through a failure rather than blanking it --
  // but never past its own reset, when it stops describing anything.
  const carried = entry && usageReadingIsCurrent(entry) ? entry : undefined;
  const next: UsageCacheEntry = reading?.label === undefined
    ? { at: Date.now(), failed: true, ...(carried?.label === undefined ? {} : { label: carried.label }), ...(carried?.windows?.length ? { windows: carried.windows } : {}) }
    : { at: Date.now(), label: reading.label, ...(reading.windows.length ? { windows: reading.windows } : {}) };
  nativeUsageCache.set(cacheKey, next);
  if (account) {
    account.usage = accountUsageFrom(next);
    // writeState merges per field, so publishing this reading cannot disturb
    // anything another terminal changed meanwhile.
    await writeState(state).catch(() => undefined);
  }
  return { windows: next.windows ?? [], ...(next.label === undefined ? {} : { label: next.label }) };
}

export async function nativeUsageLabel(
  session: HarnessSession, state: HarnessState, options: { network?: boolean } = {},
): Promise<string | undefined> {
  return (await nativeUsageReading(session, state, options))?.label;
}

function accountPseudoSession(account: AiHarnessAccount, state: HarnessState, harnessCommand: string): HarnessSession {
  const related = state.sessions.find((item) => item.accountId === account.id && item.nativeSessionId);
  return related ?? {
    id: `account:${account.id}`, route: 'local', accountId: account.id, provider: account.provider,
    model: null, effort: 'medium', accountFailover: 'never', createdAt: '', updatedAt: '', status: 'active',
    nativeHarness: harnessCommand,
  };
}

/** Usage is probed per-session above (it needs a native session id for OpenCode);
 * an account has no session of its own, so borrow one of its sessions if it has
 * any, or a bare stand-in otherwise — codexUsageProbe ignores the session
 * argument entirely, and a stand-in with no nativeSessionId simply yields no
 * OpenCode label rather than a wrong one. */
/** Whether anything can ever produce a usage figure for this harness: a probe
 * we can run, or a turn stream it reports on itself. The account picker and
 * the status line both ask this before showing a usage column at all. */
export function harnessReportsUsage(command: string): boolean {
  return NATIVE_USAGE_PROBES[command] !== undefined || NATIVE_STREAM_USAGE_READINGS[command] !== undefined;
}

export async function accountUsageLabel(
  account: AiHarnessAccount, state: HarnessState, options: { network?: boolean } = {},
): Promise<string | undefined> {
  return (await accountUsageReading(account, state, options))?.label;
}

export async function accountUsageReading(
  account: AiHarnessAccount, state: HarnessState, options: { network?: boolean } = {},
): Promise<UsageReading | undefined> {
  if (account.authKind !== 'vendor-cli') return undefined;
  const harness = localHarnessForProvider(account.provider);
  if (!harness || !harnessReportsUsage(harness.command)) return undefined;
  return nativeUsageReading(accountPseudoSession(account, state, harness.command), state, options);
}

/** What the harness last reported for this account, if it is still true.
 *
 * The picker renders from this immediately and asks the harness in the
 * background, so opening it never waits. Same rule as the read above: a
 * reading stands until the soonest window it describes resets, and a reading
 * with no window is not shown at all rather than shown forever. */
export function cachedAccountUsageLabel(account: AiHarnessAccount, state: HarnessState): string | undefined {
  if (account.authKind !== 'vendor-cli') return undefined;
  const harness = localHarnessForProvider(account.provider);
  if (!harness || !harnessReportsUsage(harness.command)) return undefined;
  void state;
  const reported = nativeUsageCache.get(usageCacheKey(harness.command, account.id));
  if (!reported || reported.failed || !(reported.windows?.length ?? 0)) return undefined;
  return usageReadingIsCurrent(reported) ? reported.label : undefined;
}

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
import { localHarnessForProvider, nativeProfileEnvironment } from './native-harness-protocol.js';
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
      : harness.command === 'claude' ? join(homedir(), '.claude')
        : harness.command === 'gemini' ? join(homedir(), '.gemini') : undefined);
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
  } else if (profileRoot && harness.command === 'gemini') {
    try {
      const settings = JSON.parse(await readFile(join(profileRoot, 'settings.json'), 'utf8')) as { model?: unknown; selectedModel?: unknown };
      const value = typeof settings.model === 'string' ? settings.model : settings.selectedModel;
      if (typeof value === 'string' && value.trim()) configured = value.trim();
    } catch { /* Gemini will choose its own default when no setting exists. */ }
    // No injected model-name list here on purpose: unlike Claude's alias
    // names just above (confirmed directly from `claude --help`'s own
    // documented flag values, plus verified live against real turns),
    // there is no equivalent verified source for Gemini's -- the previous
    // ['auto','pro','flash','flash-lite'] list was never confirmed against
    // Gemini CLI itself, and checking Antigravity CLI's real, live `models`
    // output (a different tool that also routes to Gemini models) showed
    // genuinely different, more specific names entirely
    // (gemini-3.8-flash-high, etc.) -- meaning that list was already
    // presenting stale/wrong data as if it were reliable. No Gemini CLI
    // command or local file was found that actually lists its own models
    // (confirmed: no `models` subcommand in --help, no cache file under
    // ~/.gemini/). Better to show only what's genuinely known (`configured`
    // from settings.json, or an account's own explicitly set models) than a
    // guess that looks like real data.
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

export const nativeUsageCache = new Map<string, { at: number; label?: string }>();

/** Per-harness live usage probe. Each vendor CLI exposes quota/cost through a different
 * surface (or none at all); adding a harness here is the only step needed to light up
 * its usage footer, everything else (caching, dispatch, rendering) is shared. */

export function formatTokenCount(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${Math.round(total / 1_000)}K`;
  return String(total);
}

/** Parse just the `info` object out of `opencode export <id>` without waiting for (or
 * buffering) the full transcript, which can be arbitrarily large and isn't needed here. */
export async function captureOpencodeSessionSummary(sessionId: string): Promise<{ cost: number; tokens: { input: number; output: number } } | undefined> {
  return new Promise((resolveSummary) => {
    const child = spawn('opencode', ['export', sessionId], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    const finish = (value?: { cost: number; tokens: { input: number; output: number } }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminatePortable(child);
      resolveSummary(value);
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      // `info` is written first, but a single `data` event can already carry far more
      // than that object (a pipe delivers whatever the child buffered before its first
      // flush) — search what's arrived before giving up, don't discard it unread.
      const infoStart = buffer.indexOf('"info"');
      if (infoStart === -1) return buffer.length > 16 * 1024 ? finish() : undefined;
      const braceStart = buffer.indexOf('{', infoStart);
      if (braceStart === -1) return;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = braceStart; index < buffer.length; index++) {
        const character = buffer[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === '{') depth++;
        else if (character === '}') {
          depth--;
          if (depth === 0) {
            try {
              const info = JSON.parse(buffer.slice(braceStart, index + 1)) as { cost?: number; tokens?: { input?: number; output?: number } };
              return finish({ cost: typeof info.cost === 'number' ? info.cost : 0, tokens: { input: info.tokens?.input ?? 0, output: info.tokens?.output ?? 0 } });
            } catch {
              // fail-open-ok: an incomplete stream fragment carries no usable response payload.
              return finish();
            }
          }
        }
      }
    });
    child.once('error', () => finish());
    child.once('exit', () => finish());
    const timer = setTimeout(() => finish(), 8_000);
    timer.unref();
  });
}

export async function opencodeUsageProbe(session: HarnessSession): Promise<string | undefined> {
  if (!session.nativeSessionId) return undefined;
  const summary = await captureOpencodeSessionSummary(session.nativeSessionId);
  if (!summary) return undefined;
  const total = summary.tokens.input + summary.tokens.output;
  if (!total) return undefined;
  const tokenLabel = `${formatTokenCount(total)} tok`;
  return summary.cost > 0 ? `${tokenLabel} · $${summary.cost.toFixed(2)}` : tokenLabel;
}

export async function codexUsageProbe(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<string | undefined> {
  const response = await new Promise<Record<string, unknown> | undefined>((resolveUsage) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
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
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'clikcode', version: '1.0.34' } } });
    send({ method: 'initialized', params: {} });
    const timer = setTimeout(() => finish(), 8_000);
    timer.unref();
  });
  const snapshot = response?.rateLimits && typeof response.rateLimits === 'object'
    ? response.rateLimits as Record<string, unknown> : undefined;
  const windows = [snapshot?.primary, snapshot?.secondary].filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'));
  const parts = windows.flatMap((window) => {
    const used = typeof window.usedPercent === 'number' ? window.usedPercent : undefined;
    const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : undefined;
    if (used === undefined || minutes === undefined) return [];
    const period = minutes === 300 ? '5h' : minutes === 10_080 ? 'weekly' : minutes < 1_440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1_440)}d`;
    return [`${period} ${Math.max(0, Math.min(100, 100 - used))}% left`];
  });
  return parts.length ? parts.join(' · ') : undefined;
}

/** Claude Code has no public CLI flag or subcommand for this (confirmed:
 * `--help` and `doctor` both show nothing), but the same data Claude Code's
 * own interactive UI displays is one authenticated call away: its own OAuth
 * token — already sitting in ~/.claude/.credentials.json, refreshed by
 * Claude Code's own background daemon — is accepted by
 * `/api/oauth/usage`, the private endpoint its UI calls internally.
 * Verified live: real five_hour/seven_day utilization percentages, matching
 * what the interactive session shows. This reads an already-authenticated
 * user's own token to display their own account's own usage, the same data
 * the vendor's own client already shows them — not a new grant of access. */
export async function claudeUsageProbe(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<string | undefined> {
  // Real bug, not a hypothetical: this ignored both its parameters entirely
  // and always read the default ~/.claude path, so every Claude Code
  // account -- including genuinely isolated ones under their own
  // CLAUDE_CONFIG_DIR (see the profileEnv on its catalog entry) -- reported
  // the same, first account's usage. The caller (nativeUsageLabel) already
  // computes the right environment per account; this just wasn't using it.
  let token: string | undefined;
  try {
    const configDir = environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const raw = await readFile(join(configDir, '.credentials.json'), 'utf8');
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    token = typeof parsed.claudeAiOauth?.accessToken === 'string' ? parsed.claudeAiOauth.accessToken : undefined;
  } catch {
    // fail-open-ok: a missing or malformed .credentials.json means this account is not
    // signed in, so there is no usage to label. Absence is the real answer.
    return undefined;
  }
  if (!token) return undefined;
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const body = await response.json() as {
      five_hour?: { utilization?: number };
      seven_day?: { utilization?: number };
    };
    const parts: string[] = [];
    if (typeof body.five_hour?.utilization === 'number') parts.push(`5h ${Math.max(0, Math.min(100, 100 - body.five_hour.utilization))}% left`);
    if (typeof body.seven_day?.utilization === 'number') parts.push(`weekly ${Math.max(0, Math.min(100, 100 - body.seven_day.utilization))}% left`);
    return parts.length ? parts.join(' · ') : undefined;
  } catch {
    // fail-open-ok: the usage label is optional chrome on the account chooser. If the probe
    // cannot reach the endpoint we render no label rather than failing the chooser.
    return undefined;
  }
}

export const NATIVE_USAGE_PROBES: Readonly<Partial<Record<string, NativeUsageProbe>>> = {
  codex: codexUsageProbe,
  opencode: opencodeUsageProbe,
  claude: claudeUsageProbe,
};

export async function nativeUsageLabel(session: HarnessSession, state: HarnessState): Promise<string | undefined> {
  const probe = session.nativeHarness ? NATIVE_USAGE_PROBES[session.nativeHarness] : undefined;
  if (!probe) return undefined;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const cacheKey = `${session.nativeHarness}:${account?.nativeProfile?.path ?? session.nativeSessionId ?? 'default'}`;
  const cached = nativeUsageCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30_000) return cached.label;
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const label = await probe(session, environment).catch(() => undefined);
  nativeUsageCache.set(cacheKey, { at: Date.now(), ...(label ? { label } : {}) });
  return label;
}

/** Usage is probed per-session above (it needs a native session id for OpenCode);
 * an account has no session of its own, so borrow one of its sessions if it has
 * any, or a bare stand-in otherwise — codexUsageProbe ignores the session
 * argument entirely, and a stand-in with no nativeSessionId simply yields no
 * OpenCode label rather than a wrong one. */
export async function accountUsageLabel(account: AiHarnessAccount, state: HarnessState): Promise<string | undefined> {
  if (account.authKind !== 'vendor-cli') return undefined;
  const harness = localHarnessForProvider(account.provider);
  if (!harness || !NATIVE_USAGE_PROBES[harness.command]) return undefined;
  const related = state.sessions.find((item) => item.accountId === account.id && item.nativeSessionId);
  const pseudoSession: HarnessSession = related ?? {
    id: `account:${account.id}`, route: 'local', accountId: account.id, provider: account.provider,
    model: null, effort: 'medium', accountFailover: 'never', createdAt: '', updatedAt: '', status: 'active',
    nativeHarness: harness.command,
  };
  return nativeUsageLabel(pseudoSession, state);
}

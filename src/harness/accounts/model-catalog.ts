/** Which models an account can actually use: discovered from the harness
 * itself -- its CLI, its config, or its own bundled table -- and cached only
 * for as long as what it was derived from stays the same. */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { resolveBinaryPath } from '../transport/native/binary.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition, ModelCatalogResult } from '../definition.js';
import { claudeModelAliases, claudeModelLabel, claudeModelTable } from './claude-models.js';
import { atomicWriteFile } from '../../session/store/files.js';
import { stateDirectory } from '../../session/store/paths.js';

/** Provider-specific model naming belongs to account metadata, not generic
 * session pickers or terminal renderers. Unknown models always pass through. */
export function nativeModelLabel(
  harnessCommand: string | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!model) return undefined;
  // From the installed Claude Code's own table (claude-models.ts), never a
  // constant: a constant is how the picker kept saying "Opus 5" after Claude
  // Code shipped Opus 5.5.
  return harnessCommand === 'claude' ? claudeModelLabel(model) ?? model : model;
}

/** A catalog is cached for exactly as long as what it was derived from.
 *
 * It used to be five minutes for everything, keyed on the harness alone. That
 * is wrong in both directions: a Claude Code update showed the old models for
 * the rest of the window, and an unchanged machine re-ran every `models`
 * subprocess on the clock anyway.
 *
 * Most of a catalog is derived from FILES -- the vendor binary, its config,
 * its own model cache -- and a file's identity (path, mtime, size) is a stat
 * away. So the key is those identities: any change and the entry simply does
 * not match, however recent it is; no change and it stays good indefinitely.
 *
 * The one input no file can witness is a vendor's `models` command, which
 * asks a server whose list can change on its own. Only harnesses that declare
 * one get a time limit, and only for that reason. */
interface CatalogMemoEntry {
  at: number;
  fingerprint: string;
  result: ModelCatalogResult;
}

interface ModelCatalogMemoFile {
  v: 1;
  entries: Record<string, CatalogMemoEntry>;
}

let memo: { path: string; data: ModelCatalogMemoFile; dirty: boolean } | undefined;

function memoPath(): string | undefined {
  if (process.env.VITEST && !process.env.CLIKCODE_HOME?.trim()) return undefined;
  const directory = stateDirectory();
  return directory ? join(directory, 'model-catalog.json') : undefined;
}

async function loadMemo(): Promise<ModelCatalogMemoFile> {
  const path = memoPath();
  if (memo && memo.path === (path ?? '')) return memo.data;
  let data: ModelCatalogMemoFile = { v: 1, entries: {} };
  if (path) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as ModelCatalogMemoFile;
      if (parsed?.v === 1 && parsed.entries && typeof parsed.entries === 'object') data = parsed;
    } catch { /* fail-open-ok */ }
  }
  memo = { path: path ?? '', data, dirty: false };
  return data;
}

async function saveMemo(): Promise<void> {
  const path = memoPath();
  if (!path || !memo?.dirty || memo.path !== path) return;
  memo.dirty = false;
  await atomicWriteFile(path, JSON.stringify(memo.data)).catch(() => undefined);
}

export function resetModelCatalogMemo(): void {
  modelCatalogCache.clear();
  memo = undefined;
}

const modelCatalogCache = new Map<string, { at: number; fingerprint: string; result: ModelCatalogResult }>();

/** For `modelDiscoveryArgv` only: how long a server-sourced list is trusted. */
const SERVER_LIST_TTL_MS = 300_000;

async function fileIdentity(path: string | undefined): Promise<string> {
  if (!path) return '-';
  try {
    const info = await stat(path);
    return `${path}:${info.mtimeMs}:${info.size}`;
  } catch { return `${path}:absent`; }
}

function catalogProfileRoot(harness: AiLocalHarnessDefinition, account?: AiHarnessAccount): string | undefined {
  return account?.nativeProfile?.path
    ?? (harness.profileEnv ? process.env[harness.profileEnv]?.trim() : undefined)
    ?? (harness.command === 'codex' ? join(homedir(), '.codex')
      : harness.command === 'claude' ? join(homedir(), '.claude') : undefined);
}

/** Every file nativeModelCatalogUncached reads, as identities, plus the
 * account's own model list. Kept beside the reader it describes: a file read
 * there and not listed here is a value that can go stale unnoticed. */
async function catalogFingerprint(harness: AiLocalHarnessDefinition, account?: AiHarnessAccount): Promise<string> {
  const root = catalogProfileRoot(harness, account);
  const files = [
    // The binary: an update changes what `models` prints and, for Claude
    // Code, the alias table read out of the bundle itself.
    await resolveBinaryPath(harness.binary),
    ...(harness.command === 'codex' && root ? [join(root, 'config.toml'), join(root, 'models_cache.json')] : []),
    ...(harness.command === 'claude' && root ? [join(root, 'settings.json')] : []),
  ];
  const identities = await Promise.all(files.map(fileIdentity));
  return [...identities, (account?.models ?? []).join(',')].join('|');
}

function cacheKey(harness: AiLocalHarnessDefinition, account?: AiHarnessAccount): string {
  return `${harness.command}:${account?.nativeProfile?.path ?? account?.id ?? 'default'}`;
}

/** The cached catalog, only if it still describes what is on disk now. */
async function cachedCatalog(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
  options?: { allowStale?: boolean },
): Promise<ModelCatalogResult | undefined> {
  const key = cacheKey(harness, account);
  let cached = modelCatalogCache.get(key);
  if (!cached) {
    const memoData = await loadMemo();
    const entry = memoData.entries[key];
    if (entry) {
      cached = entry;
      modelCatalogCache.set(key, entry);
    }
  }
  if (!cached) return undefined;
  if (cached.fingerprint !== await catalogFingerprint(harness, account)) return undefined;
  const isExpired = Boolean(harness.modelDiscoveryArgv && Date.now() - cached.at >= SERVER_LIST_TTL_MS);
  if (isExpired && !options?.allowStale) return undefined;
  return cached.result;
}

/** How long the model picker will wait for a vendor's own model list before
 * opening with whatever it already has. Measured on the installed harnesses:
 * `grok models` 708ms, `cursor-agent models` 1307ms, `agy models` 1807ms. The
 * 12-second cap in nativeModelCatalogUncached is a worst case for a harness
 * that hangs, not a typical cost, and waiting that long is what the
 * fire-and-forget path below was avoiding. Three seconds clears every
 * measured harness with room to spare and still bounds a bad one. */
const MODEL_CATALOG_PICKER_WAIT_MS = 3_000;

function defaultModelCatalogFallback(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): ModelCatalogResult {
  const models = new Set(account?.models ?? []);
  if (harness.command === 'claude') {
    ['opus', 'sonnet', 'haiku'].forEach((m) => models.add(m));
  }
  return { models: [...models] };
}

/** The model list for a picker that is about to open.
 *
 * A warm cache returns instantly. A cold one used to return `account.models`
 * -- usually empty -- and kick discovery off in the background, so the first
 * /model of a session showed nothing and the list only appeared if the user
 * backed out and opened it again. Now the picker waits, but only briefly:
 * past the deadline it opens with what it has and the background fill still
 * warms the cache for next time. */
export async function nativeModelCatalogForPicker(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
  waitMs = MODEL_CATALOG_PICKER_WAIT_MS,
): Promise<ModelCatalogResult> {
  const cached = await cachedCatalog(harness, account, { allowStale: true });
  if (cached) {
    if (harness.modelDiscoveryArgv && !(await cachedCatalog(harness, account))) {
      nativeModelCatalog(harness, account).catch(() => undefined);
    }
    return cached;
  }
  const fallback = defaultModelCatalogFallback(harness, account);
  // The discovery promise is never abandoned, only outrun: it keeps going and
  // populates the cache whether or not this picker still cares.
  const discovery = nativeModelCatalog(harness, account).catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs);
    timer.unref?.();
  });
  try {
    return (await Promise.race([discovery, deadline])) ?? fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The model a session will actually run with, resolved to one the harness
 * really publishes.
 *
 * Resolution order: what the harness itself is currently configured to use,
 * then the first model it publishes. There is deliberately no placeholder at
 * the end of that chain -- "default" and "automatic" are not models, and a
 * session displaying one is a session whose real model nobody knows. That was
 * a real bug twice: the picker showed "automatic", which no harness accepts,
 * and replacing it with "default" only renamed the same lie.
 *
 * Returns undefined ONLY when the harness publishes nothing at all (not
 * installed, or its discovery command failed). Callers must then show nothing
 * rather than invent a name -- an absent model is honest, a fabricated one is
 * not. `configured` is preferred even when it is not in `models`, because a
 * vendor reporting its own current setting is better evidence than a list its
 * discovery command may have truncated. */
export async function resolveNativeModel(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): Promise<string | undefined> {
  const catalog = await nativeModelCatalog(harness, account);
  const configured = catalog.configured?.trim();
  if (configured) return configured;
  return catalog.models.find((model) => model.trim().length > 0);
}

async function syncAccountModels(accountId: string, models: readonly string[]): Promise<void> {
  try {
    const { readState } = await import('../../session/state/read.js');
    const { writeState } = await import('../../session/state/write.js');
    const state = await readState();
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) return;
    const existing = new Set(account.models);
    const added = models.filter((m) => !existing.has(m));
    if (added.length === 0) return;
    account.models = [...account.models, ...added];
    await writeState(state);
  } catch {
    // Non-critical background sync
  }
}

export async function nativeModelCatalog(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): Promise<ModelCatalogResult> {
  const cached = await cachedCatalog(harness, account);
  if (cached) return cached;
  // Fingerprinted BEFORE reading, so a file that changes mid-read leaves an
  // entry that no longer matches rather than one that looks current.
  const fingerprint = await catalogFingerprint(harness, account);
  const result = await nativeModelCatalogUncached(harness, account);
  const key = cacheKey(harness, account);
  const entry: CatalogMemoEntry = { at: Date.now(), fingerprint, result };
  modelCatalogCache.set(key, entry);
  const memoData = await loadMemo();
  memoData.entries[key] = entry;
  if (memo) memo.dirty = true;
  await saveMemo().catch(() => undefined);
  if (account?.id && result.models.length) {
    syncAccountModels(account.id, result.models).catch(() => undefined);
  }
  return result;
}

/** Model identifiers in whatever a vendor's `models` command printed.
 *
 * JSON first (any `id`/`model`/`modelId`/`slug` at any depth), then a line
 * reading, because several CLIs print a human list and nothing else. */
function discoveredModelsFrom(raw: string): string[] {
  const models = new Set<string>();
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
      // "Claude Fable 5.1 [fable-5.1]" -- the display name leads and the real
      // slug is bracketed (Augment Auggie prints exactly this). Taking the
      // first token alone found "Claude" and threw the slug away. Status words
      // get bracketed too, so only a slug-shaped one counts.
      const bracketed = /\[([a-z0-9][a-z0-9._:/-]*)\]\s*$/i.exec(clean)?.[1];
      if (bracketed && !/^(?:default|current|active|selected|recommended|beta|new|free)$/i.test(bracketed)) {
        add(bracketed);
        continue;
      }
      const token = clean.split(/\s+/, 1)[0]?.replace(/^['"`]|['"`,:]$/g, '');
      if (token && (clean === token || /[\/.\d:_-]/.test(token))) add(token);
    }
  }
  return [...models];
}

async function nativeModelCatalogUncached(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): Promise<ModelCatalogResult> {
  const models = new Set(account?.models ?? []);
  const addDiscoveredModels = (raw: string): void => { for (const model of discoveredModelsFrom(raw)) models.add(model); };
  const profileRoot = catalogProfileRoot(harness, account);
  let labels: Record<string, string> | undefined;
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
    // The aliases and their names come from the installed Claude Code's own
    // table. If it cannot be read, the aliases alone are still right --
    // Claude Code resolves them to its latest per family itself -- and they
    // are shown bare rather than with a label that may be a release behind.
    const table = await claudeModelTable(harness.binary);
    const aliases = claudeModelAliases(table);
    (aliases.length ? aliases : ['fable', 'opus', 'sonnet', 'haiku']).forEach((model) => models.add(model));
    if (table) {
      labels = {};
      for (const alias of aliases) {
        const name = table.displayNames[table.aliases[alias]!];
        if (name) labels[alias] = name;
      }
    }
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
    ...(labels ? { labels } : {}),
  };
}

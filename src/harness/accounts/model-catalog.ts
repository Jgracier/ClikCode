/** Which models an account can actually use: discovered live from the
 * harness's own CLI where one exists, hardcoded only where verified, and
 * cached because a picker cannot wait on a subprocess. */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition, ModelCatalogResult } from '../definition.js';

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

/** How long the model picker will wait for a vendor's own model list before
 * opening with whatever it already has. Measured on the installed harnesses:
 * `grok models` 708ms, `cursor-agent models` 1307ms, `agy models` 1807ms. The
 * 12-second cap in nativeModelCatalogUncached is a worst case for a harness
 * that hangs, not a typical cost, and waiting that long is what the
 * fire-and-forget path below was avoiding. Three seconds clears every
 * measured harness with room to spare and still bounds a bad one. */
export const MODEL_CATALOG_PICKER_WAIT_MS = 3_000;

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
  const cacheKey = `${harness.command}:${account?.nativeProfile?.path ?? account?.id ?? 'default'}`;
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MODEL_CATALOG_CACHE_TTL_MS) return cached.result;
  const fallback = { models: [...new Set(account?.models ?? [])] };
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

/** Synchronous variant for callers that genuinely cannot await: returns only
 * what is already cached or known locally, and refreshes in the background. */
export function nativeModelCatalogCached(
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

/** Model identifiers in whatever a vendor's `models` command printed.
 *
 * JSON first (any `id`/`model`/`modelId`/`slug` at any depth), then a line
 * reading, because several CLIs print a human list and nothing else. */
export function discoveredModelsFrom(raw: string): string[] {
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

export async function nativeModelCatalogUncached(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): Promise<ModelCatalogResult> {
  const models = new Set(account?.models ?? []);
  const addDiscoveredModels = (raw: string): void => { for (const model of discoveredModelsFrom(raw)) models.add(model); };
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

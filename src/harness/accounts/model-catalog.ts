/** Which models an account can actually use: discovered from the harness
 * itself -- its CLI, its config, or its own bundled table -- and cached only
 * for as long as what it was derived from stays the same. */

import { turboFitCpuLaneRows } from './turbofit-local.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { nativeAccountEnvironment, nativeProfileEnvironment } from '../transport/profile-environment.js';
import { resolveBinaryPath } from '../transport/native/binary.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition, ModelCatalogConnect, ModelCatalogResult } from '../definition.js';
import { claudeModelAliases, claudeModelLabel, claudeModelTable } from './claude-models.js';
import { discoverHermesModels, hermesCachedModels, hermesTurboFitCatalogFiles } from './hermes-discovery.js';
import { discoverOpenClawModels } from './openclaw-discovery.js';
import { discoverOpencodeConnect, opencodeVerboseModels } from './opencode-discovery.js';
import { freePlanModels, planIsFree, preferredFreeModel } from './free-plan.js';
import { copilotAccountModels } from './cli-usage-probes.js';
import { discoverPiProviders, piConnect, piModels } from './pi-discovery.js';
import { discoverGooseProviders, GOOSE_DRIVEN_HARNESSES, gooseConnect, gooseModelsDevModels, modelsDevCache, modelsDevFiles, modelsDevProvider } from './goose-discovery.js';
import { expandAuthPath } from './auth-files.js';
import { discoverAiderModels, openRouterCacheFile } from './aider-discovery.js';
import { acpDiscoverySession, acpProbeArgv, acpSessionModels, queryAcp } from './acp-query.js';
import { localHarnessForCommand, modelDisplayId, modelIdFromDisplay } from '../../runtime/lazy-bridge.js';
import { modelLabel } from '../model-label.js';
import { jsonMemo } from '../../session/store/json-memo.js';

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
  if (harnessCommand === 'claude') return modelLabel(claudeModelLabel(model) ?? model, harnessCommand);
  // A harness that drives other providers names them one way everywhere:
  // `provider/model`, and never by its own name again, which is on screen.
  try {
    const harness = harnessCommand ? localHarnessForCommand(harnessCommand) : undefined;
    return harness ? harnessModelLabel(harness, model) : model;
  } catch {
    return model; // fail-open-ok: a label only; without the catalog the id is still the truth.
  }
}

/** Cursor's ids carry the variant's settings in brackets -- `default[]` is
 * Auto, `claude-opus-5-5[context=300k,effort=medium,fast=false]` -- and its
 * ACP list names each one ("Auto", "claude-opus-5-5"). The id is what goes
 * back to the vendor; the name is what a person reads. */
const BRACKETED_MODEL = /^([^[\]]+)\[([^\]]*)\]$/;
const vendorModelNames = new Map<string, string>();

/** Remember the names a catalog carries for bracketed ids, so every label --
 * the status line included, which has no catalog in hand -- can use them. */
export function rememberVendorModelNames(harness: AiLocalHarnessDefinition, catalog: Pick<ModelCatalogResult, 'labels'> | undefined): void {
  for (const [model, name] of Object.entries(catalog?.labels ?? {})) {
    if (BRACKETED_MODEL.test(model) && name) vendorModelNames.set(`${harness.command}\0${model}`, name);
  }
}

/** A bracketed id's settings, readable: `effort high · 300k context · fast`.
 * A flag set false says nothing worth reading and is left out. */
export function modelSettingsDetail(model: string): string | undefined {
  const inner = BRACKETED_MODEL.exec(model)?.[2];
  if (!inner) return undefined;
  const parts = inner.split(',').flatMap((pair) => {
    const [key, value] = pair.split('=').map((part) => part.trim()) as [string, string | undefined];
    if (!key || value === 'false') return [];
    if (value === undefined || value === 'true') return [key.replace(/_/g, ' ')];
    if (key === 'context') return [`${value} context`];
    return [`${key.replace(/_/g, ' ')} ${value}`];
  });
  return parts.length ? parts.join(' · ') : undefined;
}

/** One model of `harness` as its lists and status lines show it. */
export function harnessModelLabel(harness: AiLocalHarnessDefinition, model: string): string {
  const bracketed = BRACKETED_MODEL.exec(model);
  if (bracketed) return vendorModelNames.get(`${harness.command}\0${model}`) ?? bracketed[1]!.trim();
  return modelLabel(modelDisplayId(harness, model), harness.command, harness.provider);
}

/** The catalog id a model typed the way it is shown names: itself when the
 * harness publishes it, else the one model whose label it is (`big-pickle`
 * for OpenCode's `opencode/big-pickle`), else the harness's own spelling of
 * the display form (`claude-code:sonnet` is Goose's `claude-code/sonnet`).
 * With no catalog in hand (`models` empty) it is that spelling alone. */
export function modelIdFromLabel(harness: AiLocalHarnessDefinition, models: readonly string[], typed: string): string {
  if (models.includes(typed)) return typed;
  const spelled = modelIdFromDisplay(harness, typed);
  if (models.includes(spelled)) return spelled;
  const matches = models.filter((model) => harnessModelLabel(harness, model) === typed || modelDisplayId(harness, model) === typed);
  return matches.length === 1 ? matches[0]! : spelled;
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
 * The one input no file can witness is a vendor's model list, which may
 * change on its server. A list read over ACP needs no clock: every session
 * the agent opens reports it, and recordLiveModelCatalog keeps the entry
 * current from there. A list only a `models` command prints gets a time
 * limit. */
interface CatalogMemoEntry {
  at: number;
  fingerprint: string;
  result: ModelCatalogResult;
}

interface ModelCatalogMemoFile {
  v: 1;
  entries: Record<string, CatalogMemoEntry>;
}

const memo = jsonMemo<ModelCatalogMemoFile>('model-catalog.json', () => ({ v: 1, entries: {} }), (parsed) => {
  const file = parsed as ModelCatalogMemoFile;
  return file.v === 1 && file.entries && typeof file.entries === 'object' ? file : undefined;
});

/** Discoveries running now, by harness+account and the identity of what
 * they read (catalogFingerprint). A chat opening asks for its catalog from
 * several places at once -- the warm-up, the session's model, the effort
 * list -- and each used to run the vendor's `models` itself: three `grok
 * models` at every start. They now share one; a changed binary or sign-in
 * is a different identity, so it is never answered by a run that predates it. */
const discoveries = new Map<string, Promise<ModelCatalogResult>>();

export function resetModelCatalogMemo(): void {
  memo.reset();
  discoveries.clear();
}

/** How long a model list printed by a vendor's `models` command is trusted. */
const SERVER_LIST_TTL_MS = 300_000;

function serverModelList(harness: AiLocalHarnessDefinition): boolean {
  // Copilot's account list moves with its quota (spent chat lists `auto` alone).
  return harness.command === 'copilot' || (!listsModelsLive(harness) && Boolean(harness.modelDiscoveryArgv || (harness.acp && harness.acp.listsModels !== false)));
}

/** The catalog is the list an ACP session offers, so each live session
 * reports it and discovery has to start the agent only when none has yet.
 * Not a harness with a `models` command, which is read from that instead
 * (its ACP list can differ: OpenCode's `models` printed 8, its session 10),
 * nor one that picks a provider first (Goose), whose session lists only
 * that provider's models. */
function listsModelsLive(harness: AiLocalHarnessDefinition): boolean {
  return Boolean(harness.acp && harness.acp.listsModels !== false && !harness.acp.providerConfigId && !harness.modelDiscoveryArgv);
}

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
      : harness.command === 'claude' ? join(homedir(), '.claude')
        : harness.command === 'hermes' ? join(homedir(), '.hermes')
          : harness.command === 'openclaw' ? join(homedir(), '.openclaw')
            : harness.command === 'vibe' ? join(homedir(), '.vibe') : undefined);
}

/** Harnesses whose list comes from the models.dev catalog. */
const MODELS_DEV_HARNESSES: ReadonlySet<string> = new Set(['copilot', 'goose']);

/** Every file nativeModelCatalogUncached reads, as identities. Kept beside the reader it describes: a file read
 * there and not listed here is a value that can go stale unnoticed. */
async function catalogFingerprint(harness: AiLocalHarnessDefinition, account?: AiHarnessAccount): Promise<string> {
  const root = catalogProfileRoot(harness, account);
  const files = [
    // The binary: an update changes what `models` prints and, for Claude
    // Code, the alias table read out of the bundle itself.
    await resolveBinaryPath(harness.binary),
    ...(harness.acp?.binary ? [await resolveBinaryPath(harness.acp.binary)] : []),
    ...(harness.command === 'codex' && root ? [join(root, 'config.toml'), join(root, 'models_cache.json')] : []),
    ...(harness.command === 'claude' && root ? [join(root, 'settings.json')] : []),
    ...(harness.command === 'hermes' && root ? [join(root, 'config.yaml'), join(root, 'provider_models_cache.json'), join(root, 'auth.json'), join(root, '.env')] : []),
    ...(harness.command === 'hermes' ? await hermesTurboFitCatalogFiles(nativeProfileEnvironment(account?.nativeProfile)) : []),
    // OpenClaw's sign-ins live in the agent's SQLite auth store.
    ...(harness.command === 'openclaw' && root ? [join(root, 'openclaw.json'), join(root, 'agents', 'main', 'agent', 'openclaw-agent.sqlite')] : []),
    ...(harness.command === 'vibe' && root ? [join(root, 'config.toml')] : []),
    ...(harness.command === 'goose' ? [join(homedir(), '.config', 'goose', 'config.yaml'), join(homedir(), '.config', 'goose', 'secrets.yaml')] : []),
    // The models.dev catalog a list was read from: a newer copy is a new list.
    ...(MODELS_DEV_HARNESSES.has(harness.command) ? modelsDevFiles() : []),
    ...(harness.command === 'aider' ? [openRouterCacheFile()] : []),
    // A sign-in changes which models a vendor lists (Pi, Qwen, Cline): its
    // credential files are part of what the list was read from.
    ...(harness.authFiles ?? []).map((entry) => expandAuthPath(entry.path.replace(/\/$/, ''), {
      ...process.env, ...(account?.nativeProfile ? { [account.nativeProfile.env]: account.nativeProfile.path } : {}),
    })),
  ];
  const identities = await Promise.all(files.map(fileIdentity));
  // Goose lists the models of the CLIs it drives, so their lists are its too.
  const driven = harness.command === 'goose'
    ? await Promise.all([...new Set(Object.values(GOOSE_DRIVEN_HARNESSES))].map(async (command) => {
      const drivenHarness = localHarnessForCommand(command);
      return drivenHarness ? catalogFingerprint(drivenHarness) : '';
    }))
    : [];
  // A ClikCode update can change a harness from CLI discovery to ACP without
  // changing either vendor binary. Cached CLI IDs must not then be offered to
  // an ACP session (Cursor's IDs, for example, have a different shape).
  const discoveryContract = JSON.stringify({
    transport: harness.transport,
    acp: harness.acp && { binary: harness.acp.binary, argv: harness.acp.argv, listsModels: harness.acp.listsModels },
    modelDiscoveryArgv: harness.modelDiscoveryArgv,
  });
  // Not the account's own model list: discovery writes its answer there
  // (syncAccountModels), so a fingerprint holding it invalidated its own
  // entry -- the next ask, a moment later, ran the vendor's `models` again.
  // cachedCatalog checks the account's models against the entry instead.
  return [discoveryContract, ...identities, ...driven].join('|');
}

function cacheKey(harness: AiLocalHarnessDefinition, account?: AiHarnessAccount): string {
  return `${harness.command}:${account?.nativeProfile?.path ?? account?.id ?? 'default'}`;
}

/** The cached catalog, only if it still describes what is on disk now. */
async function cachedCatalog(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
  options?: { allowStale?: boolean; fingerprint?: string },
): Promise<ModelCatalogResult | undefined> {
  // The memo follows the file (json-memo.ts), so an entry another ClikCode
  // process discovered is found here: one discovery per machine, not one per
  // window.
  const cached = (await memo.load()).entries[cacheKey(harness, account)];
  if (!cached) return undefined;
  if (cached.fingerprint !== (options?.fingerprint ?? await catalogFingerprint(harness, account))) return undefined;
  // A model the account lists that the entry lacks was added since: the
  // list is read again with it.
  if (account?.models?.some((model) => !cached.result.models.includes(model))) return undefined;
  if (harness.acp && cached.result.models.length === 0) return undefined;
  const isExpired = serverModelList(harness) && Date.now() - cached.at >= SERVER_LIST_TTL_MS;
  if (isExpired && !options?.allowStale) return undefined;
  rememberVendorModelNames(harness, cached.result);
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

/** Claude Code's family aliases, for when its own table cannot be read:
 * Claude Code resolves each to its latest model itself. */
const CLAUDE_FALLBACK_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

function defaultModelCatalogFallback(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): ModelCatalogResult {
  const models = new Set(account?.models ?? []);
  if (harness.command === 'claude') CLAUDE_FALLBACK_ALIASES.forEach((model) => models.add(model));
  return { models: [...models] };
}

/** Fire-and-forget fill of the model cache so `/model` is warm when opened.
 * Called when a chat opens and when its provider or account changes. A warm
 * cache makes the picker instant; a cold one still waits briefly inside
 * nativeModelCatalogForPicker. */
export function warmNativeModelCatalog(
  harness: AiLocalHarnessDefinition | undefined,
  account?: AiHarnessAccount,
): void {
  if (!harness) return;
  void nativeModelCatalog(harness, account).catch(() => undefined);
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
  waitMs = harness.acp?.listsModels ? 10_000 : MODEL_CATALOG_PICKER_WAIT_MS,
): Promise<ModelCatalogResult> {
  const cached = await cachedCatalog(harness, account, { allowStale: true });
  if (cached) {
    if (serverModelList(harness) && !(await cachedCatalog(harness, account))) {
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
  const free = freePlanModels(harness, account, catalog);
  const chosen = harness.defaultModel && catalog.models.includes(harness.defaultModel) ? harness.defaultModel : catalog.configured?.trim();
  // A free plan starts on a model it runs, not on a default it refuses
  // (Cursor's ACP session opens on a named model a Free plan cannot use).
  if (chosen && !(planIsFree(account?.plan) && free.size && !free.has(chosen))) return chosen;
  // Nothing chosen: a free model before the first listed, which was a paid
  // one Kilo refused on an empty balance.
  return preferredFreeModel(free) ?? chosen ?? catalog.models.find((model) => model.trim().length > 0);
}

async function syncAccountModels(accountId: string, models: readonly string[]): Promise<void> {
  try {
    const { readState } = await import('../../session/state/read.js');
    const { writeState } = await import('../../session/state/write.js');
    // Accounts only: opening every transcript for a background model sync
    // was paying the full library cost on every cold catalog.
    const state = await readState({ transcripts: [] });
    const account = state.accounts.find((item) => item.id === accountId);
    // An empty answer is a discovery that failed, not a vendor with no
    // models: it must not wipe what the account had.
    if (!account || models.length === 0) return;
    // The vendor's current list replaces the stored one. Appending kept every
    // model any past discovery ever produced -- retired models, and lines an
    // older parser misread as models ('Repo-map', a docs URL) -- forever.
    const next = [...new Set(models)];
    if (next.length === account.models.length && next.every((model, index) => model === account.models[index])) return;
    account.models = next;
    await writeState(state);
  } catch {
    // Non-critical background sync
  }
}

export async function nativeModelCatalog(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): Promise<ModelCatalogResult> {
  // Fingerprinted BEFORE reading, so a file that changes mid-read leaves an
  // entry that no longer matches rather than one that looks current.
  const fingerprint = await catalogFingerprint(harness, account);
  const cached = await cachedCatalog(harness, account, { fingerprint });
  if (cached) return cached;
  const key = [cacheKey(harness, account), fingerprint, ...(account?.models ?? [])].join('\n');
  const running = discoveries.get(key);
  if (running) return running;
  const discovery = discoverModelCatalog(harness, account, fingerprint)
    .finally(() => { if (discoveries.get(key) === discovery) discoveries.delete(key); });
  discoveries.set(key, discovery);
  return discovery;
}

async function discoverModelCatalog(
  harness: AiLocalHarnessDefinition,
  account: AiHarnessAccount | undefined,
  fingerprint: string,
): Promise<ModelCatalogResult> {
  const result = await nativeModelCatalogUncached(harness, account);
  rememberVendorModelNames(harness, result);
  // A list read from a server (Copilot's, from models.dev) that came back
  // empty was offline, not empty: remembered, it stayed empty until Copilot
  // itself was updated. Asked again next time instead.
  if (!result.models.length && (MODELS_DEV_HARNESSES.has(harness.command) || harness.command === 'aider' || harness.acp)) return result;
  await rememberCatalog(harness, account, fingerprint, result);
  return result;
}

async function rememberCatalog(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined, fingerprint: string, result: ModelCatalogResult,
): Promise<void> {
  // The save keeps what other processes wrote meanwhile (json-memo.ts).
  (await memo.load()).entries[cacheKey(harness, account)] = { at: Date.now(), fingerprint, result };
  memo.changed();
  await memo.save();
  if (account?.id && result.models.length) {
    syncAccountModels(account.id, result.models).catch(() => undefined);
  }
}

/** The models a live ACP session just offered (its session/new or
 * session/load answer), taken as this harness's catalog for this account:
 * the same list discovery would start the agent to read, so with a session
 * open nothing is spawned for it. Keyed like discovery, on the binary and
 * sign-in it came from. A loaded session's current model is the one that
 * chat last used, not the agent's default, so only a new session's is
 * taken as `configured`. */
export async function recordLiveModelCatalog(
  harness: AiLocalHarnessDefinition,
  account: AiHarnessAccount | undefined,
  answer: Readonly<Record<string, unknown>>,
  fresh: boolean,
): Promise<void> {
  if (!listsModelsLive(harness)) return;
  const listed = acpSessionModels(answer);
  if (!listed.models.length) return;
  const fingerprint = await catalogFingerprint(harness, account);
  const previous = (await memo.load()).entries[cacheKey(harness, account)];
  const configured = fresh ? listed.current : previous?.fingerprint === fingerprint ? previous.result.configured : undefined;
  const result = await nativeModelCatalogUncached(harness, account, { ...listed, current: configured });
  rememberVendorModelNames(harness, result);
  if (previous?.fingerprint === fingerprint && JSON.stringify(previous.result) === JSON.stringify(result)) return;
  await rememberCatalog(harness, account, fingerprint, result);
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
  /** What a live session already offered: then no agent is started for it. */
  liveListed?: { models: string[]; labels: Record<string, string>; current?: string },
): Promise<ModelCatalogResult> {
  const models = new Set(account?.models ?? []);
  const addDiscoveredModels = (raw: string): void => { for (const model of discoveredModelsFrom(raw)) models.add(model); };
  const profileRoot = catalogProfileRoot(harness, account);
  let labels: Record<string, string> | undefined;
  let configured: string | undefined;
  let connect: ModelCatalogConnect[] | undefined;
  let localRecommendations: ModelCatalogResult['localRecommendations'];
  let free: string[] | undefined;
  // Hermes' and OpenClaw's inventories are the whole truth: ids remembered on
  // the account from before (bare, or from a provider since signed out)
  // would run wrong.
  const adoptInventory = (inventory: { models: readonly string[]; labels: Record<string, string>; configured?: string; connect: ModelCatalogConnect[] }): void => {
    models.clear();
    inventory.models.forEach((model) => models.add(model));
    labels = { ...labels, ...inventory.labels };
    if (inventory.configured) configured = inventory.configured;
    connect = inventory.connect;
  };
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
    (aliases.length ? aliases : CLAUDE_FALLBACK_ALIASES).forEach((model) => models.add(model));
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
  // Hermes has no `models` command. `hermes model` is an interactive picker;
  // its list (signed-in providers only) is read from the install's inventory,
  // with the provider cache as the fallback. Every id is `provider:model`, so
  // the choice keeps its provider. The configured model is `config get model
  // --json`'s `default` plus `provider` (`{"default":"gpt-6-astra","provider":"openai-codex",...}`).
  if (harness.command === 'hermes') {
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    const inventory = await discoverHermesModels(harness, account).catch(() => undefined);
    if (inventory) {
      adoptInventory(inventory);
      // On a machine TurboFit sees no GPU in, its recommendations are GPU
      // measurements; the CPU lanes, measured or estimated here, replace them.
      const cpuLanes = await turboFitCpuLaneRows(harness, account).catch(() => []);
      localRecommendations = cpuLanes.length ? cpuLanes : inventory.localRecommendations;
    } else if (profileRoot) {
      try {
        for (const model of hermesCachedModels(await readFile(join(profileRoot, 'provider_models_cache.json'), 'utf8'))) models.add(model);
      } catch { /* The cache is optional and only holds providers that have been fetched. */ }
    }
    try {
      if (!configured) {
        const parsed = JSON.parse(await captureNativeHarnessOutput(harness, ['config', 'get', 'model', '--json'], environment, 12_000)) as { default?: unknown; provider?: unknown };
        const model = typeof parsed.default === 'string' ? parsed.default.trim() : '';
        const provider = typeof parsed.provider === 'string' ? parsed.provider.trim() : '';
        if (model) configured = provider ? `${provider}:${model}` : model;
      }
    } catch { /* Keep account models. A missing config is not an empty catalog. */ }
  }
  if (harness.command === 'openclaw') {
    const inventory = await discoverOpenClawModels(harness, account).catch(() => undefined);
    if (inventory) adoptInventory(inventory);
  }
  // Aider: the models of each provider it has a key for (aider-discovery.ts).
  if (harness.command === 'aider') {
    const found = await discoverAiderModels(harness, nativeAccountEnvironment(harness, account)).catch(() => undefined);
    if (found) {
      found.models.forEach((model) => models.add(model));
      labels = { ...labels, ...found.labels };
      if (found.connect.length) connect = found.connect;
    }
  }
  // Copilot: the models its own server offers this account (`models.list`
  // on `copilot --headless`, which only its own sign-in may ask). The public
  // models.dev catalog, what Copilot offers anyone, only when that fails.
  if (harness.command === 'copilot') {
    const own = await copilotAccountModels(nativeProfileEnvironment(account?.nativeProfile)).catch(() => undefined);
    const listed = own ?? modelsDevProvider(await modelsDevCache(), 'github-copilot');
    // The account's own list is the whole truth; ids remembered from the
    // public catalog would offer models this plan refuses.
    if (own) models.clear();
    listed.models.forEach((model) => models.add(model));
    labels = { ...labels, ...listed.labels };
  }
  // Goose: its configured providers' models, and the rest to set up. A
  // provider that is another agent CLI (claude-code) lists that harness's own
  // models, so its sign-in carries over with nothing more to do.
  if (harness.command === 'goose') {
    const providers = await discoverGooseProviders(harness, nativeProfileEnvironment(account?.nativeProfile)).catch(() => undefined);
    if (providers) {
      const modelsDev = await modelsDevCache();
      labels = { ...labels };
      for (const provider of providers.filter((item) => item.configured)) {
        const drivenCommand = GOOSE_DRIVEN_HARNESSES[provider.id];
        const drivenHarness = drivenCommand ? localHarnessForCommand(drivenCommand) : undefined;
        if (drivenHarness) {
          const driven = await nativeModelCatalog(drivenHarness).catch(() => undefined);
          for (const model of driven?.models ?? []) {
            models.add(`${provider.id}/${model}`);
            const name = driven?.labels?.[model];
            if (name) labels[`${provider.id}/${model}`] = name;
          }
        } else {
          gooseModelsDevModels(modelsDev, provider.id).forEach((model) => models.add(model));
        }
      }
      connect = gooseConnect(providers);
    }
  }
  // No list command, but the ACP session says (Cline: 318 models through its
  // own gateway, none of which ClikCode could offer before).
  if (harness.acp && harness.acp.listsModels !== false && !harness.modelDiscoveryArgv) {
    const listed = liveListed ?? await queryAcp(harness.acp.binary ?? harness.binary, [...harness.acp.argv, ...await acpProbeArgv(harness, account)], nativeProfileEnvironment(account?.nativeProfile),
      async (request, capabilities) => acpSessionModels(await acpDiscoverySession(request, capabilities, cacheKey(harness, account))), 30_000).catch(() => undefined);
    if (listed?.models.length) {
      // A declared ACP model list is authoritative for ACP sessions. Keeping
      // persisted CLI ids alongside it can select an id this transport does
      // not accept after an upgrade (Cursor's `auto` vs `default[]`).
      if (harness.acp.listsModels === true) models.clear();
      listed.models.forEach((model) => models.add(model));
      labels = { ...labels, ...listed.labels };
      // Current only if listed: a model ClikCode set on the session is
      // reported back as current even when the plan refuses it (Kiro), and
      // added here it read as one the account's plan offers.
      if (listed.current && listed.models.includes(listed.current)) configured ??= listed.current;
    }
  }
  if (harness.modelDiscoveryArgv) {
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    try {
      const printed = await captureNativeHarnessOutput(harness, harness.modelDiscoveryArgv, environment, 12_000);
      // OpenCode and Kilo print only connected providers' models, each with
      // its price and (Kilo) whether it is free; the rest of what they know
      // is offered as a sign-in.
      if (harness.command === 'opencode' || harness.command === 'kilo') {
        const verbose = opencodeVerboseModels(printed);
        verbose.models.forEach((model) => models.add(model));
        free = verbose.free;
        connect = await discoverOpencodeConnect(harness, verbose.models);
      } else {
        addDiscoveredModels(printed);
      }
      // Pi prints a provider/model table; the generic reader cannot see a
      // model in it. Its other providers are signed in to inside Pi.
      if (harness.command === 'pi') {
        const piListed = piModels(printed);
        for (const model of [...discoveredModelsFrom(printed), ...models]) if (model.startsWith('/')) models.delete(model);
        piListed.forEach((model) => models.add(model));
        connect = piConnect(await discoverPiProviders(harness), piListed);
      }
    } catch { /* Keep configured/account models and the custom-ID option available. */ }
  }
  if (configured) models.add(configured);
  return {
    ...(configured ? { configured } : {}),
    models: [...models],
    ...(labels ? { labels } : {}),
    ...(free?.length ? { free } : {}),
    ...(connect?.length ? { connect } : {}),
    ...(localRecommendations?.length ? { localRecommendations } : {}),
  };
}

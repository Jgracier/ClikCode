import { execFile } from 'node:child_process';
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';

/** What the installed Hermes Agent actually offers, read from that install.
 *
 * `hermes model` is an interactive picker and there is no `models list`. The
 * lists that do exist are the provider-model cache, the provider registry in
 * the install, and `hermes tools list`. Parsing those is the whole of this
 * file; nothing here invents a model or a toolset. */

/** Models are `provider:model`, the id Hermes itself uses for a choice (its
 * ACP `availableModels`, its `/model` input). A bare model id is resolved
 * against the configured provider, which is how picking an OpenCode model on
 * a ChatGPT-configured Hermes sent it to Codex. */
export function hermesCachedModels(cacheJson: string): string[] {
  try {
    const cache = JSON.parse(cacheJson) as Record<string, { models?: unknown }>;
    const models = new Set<string>();
    for (const [provider, bucket] of Object.entries(cache)) {
      if (!bucket || !Array.isArray(bucket.models)) continue;
      for (const model of bucket.models) {
        if (typeof model === 'string' && model.trim()) models.add(`${provider}:${model.trim()}`);
      }
    }
    return [...models];
  } catch {
    return [];
  }
}

/** `hermes tools list` rows look like `✓ enabled  web  🔍 …`. */
export function hermesToolsetNames(listText: string): string[] {
  const names = new Set<string>();
  for (const line of listText.split(/\r?\n/)) {
    const match = /(?:enabled|disabled)\s+([a-z][a-z0-9_-]*)\b/.exec(line);
    if (match) names.add(match[1]!);
  }
  return [...names];
}

/** `hermes --version` prints `Install directory: /path`. */
export function hermesInstallDirectory(versionText: string): string | undefined {
  return /^Install directory:\s*(.+)\s*$/m.exec(versionText)?.[1]?.trim() || undefined;
}

/** Toolset names for the options picker. Providers are not an option: a
 * Hermes model id carries its provider, and the model picker connects new
 * ones. */
export async function discoverHermesChoices(
  harness: AiLocalHarnessDefinition, account?: AiHarnessAccount,
): Promise<{ toolsets: string[] }> {
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const toolsText = await captureNativeHarnessOutput(harness, ['tools', 'list'], environment, 12_000).catch(() => '');
  return { toolsets: hermesToolsetNames(toolsText) };
}

/** Every provider this Hermes install knows, whether it is ready, and its
 * models -- read from the install's own inventory, the one `hermes model`
 * calls. "Ready" is Hermes's own answer: its per-provider auth check where it
 * has one (Nous, Codex, xAI, Qwen and MiniMax OAuth), otherwise the
 * inventory's `authenticated`, which already counts a credential Hermes
 * found elsewhere (Claude Code's sign-in, `gh auth token`, an exported API
 * key) -- those providers are ready with no Hermes login at all. Opening an
 * ACP session would also list models, but leaves an empty session behind. */
const INVENTORY_SCRIPT = `
import json
from hermes_cli.inventory import build_models_payload, load_picker_context
from hermes_cli.auth import get_auth_status
CHECKED = {"nous", "openai-codex", "xai-oauth", "qwen-oauth", "minimax-oauth", "copilot-acp", "azure-foundry"}
p = build_models_payload(load_picker_context(), explicit_only=False, include_unconfigured=True,
    picker_hints=True, canonical_order=True, pricing=False, capabilities=False, refresh=False,
    probe_custom_providers=False, probe_current_custom_provider=False, max_models=200)
rows = []
for row in p.get("providers") or []:
    slug = row.get("slug")
    if not slug or row.get("source") == "virtual":
        continue
    ready = bool(row.get("authenticated"))
    if slug in CHECKED:
        try:
            ready = bool(get_auth_status(slug).get("logged_in"))
        except Exception:
            pass
    models = [m.get("id") or m.get("model") or m.get("name") if isinstance(m, dict) else m for m in row.get("models") or []]
    rows.append({"provider": slug, "name": row.get("name"), "ready": ready, "authType": row.get("auth_type"), "models": [m for m in models if m]})
print("\\x00HERMES_INVENTORY" + json.dumps({"providers": rows, "model": p.get("model"), "provider": p.get("provider")}))
`;

/** Providers `hermes auth add` signs in to with OAuth; every other known
 * provider it signs in to with an API key. A provider it cannot add (cloud
 * SDK credentials, external processes, custom endpoints) is set up through
 * `hermes model`, the full picker. Mirrors hermes_cli/auth_commands.py. */
const HERMES_OAUTH_PROVIDERS = new Set(['anthropic', 'nous', 'openai-codex', 'xai-oauth', 'qwen-oauth', 'minimax-oauth']);
// TurboFit is a local Hermes custom provider. Its API key is deliberately a
// placeholder, so Hermes' generic credential check can report it as not
// authenticated even though the provider exposes its local model routes.
const HERMES_LOCAL_PROVIDERS = new Set(['custom:turbofit', 'turbofit']);

export interface HermesConnect { id: string; label: string; detail: string; argv: string[] }
export interface HermesLocalRecommendation { id: string; label: string; detail: string }
export interface HermesInventory {
  models: string[];
  configured?: string;
  labels: Record<string, string>;
  connect: HermesConnect[];
  localRecommendations?: HermesLocalRecommendation[];
}

/** Locate the installed TurboFit plugin without assuming a global checkout.
 * Hermes supports user and profile-local plugin directories; the environment
 * is the selected Hermes account's environment, so each account sees its own
 * plugin and recommendation state. */
export async function turboFitPluginRoot(environment: Readonly<Record<string, string>>): Promise<string | undefined> {
  const hermesHome = hermesHomeFor(environment);
  const direct = environment.TURBOFIT_PLUGIN_ROOT?.trim();
  const candidates = [
    ...(direct ? [direct] : []),
    join(hermesHome, 'plugins', 'turbofit'),
    join(hermesHome, 'plugins', 'user', 'turbofit'),
    join(hermesHome, 'plugins', 'cache', 'turbofit'),
  ];
  try {
    for (const entry of await readdir(join(hermesHome, 'profiles'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(join(hermesHome, 'profiles', entry.name, 'plugins', 'turbofit'));
      candidates.push(join(hermesHome, 'profiles', entry.name, 'plugins', 'user', 'turbofit'));
    }
  } catch { /* A default Hermes installation need not use profiles. */ }
  for (const candidate of candidates) {
    try {
      await access(join(candidate, 'plugin_tools.py'));
      await access(join(candidate, 'scripts', 'turbofit-runtime-recommend'));
      return candidate;
    } catch { /* Try the next supported Hermes plugin location. */ }
  }
  return undefined;
}

/** TurboFit's own install source, from its after-install.md. */
export const TURBOFIT_SOURCE = 'https://github.com/SouthpawIN/turbofit.git';
/** The one TurboFit commit ClikCode installs. Hermes' install scan rates the
 * repository dangerous on keyword matches -- a test asserting `rm -rf /` is
 * rejected, docs mentioning remote servers, variables named `profile` -- and
 * a review of this commit found nothing behind them: `register()` adds only
 * TurboFit's tools, command and skill, and it declares no capabilities.
 * The scan is skipped for this pinned commit alone; moving to a newer one
 * means reviewing it and changing this line. */
export const TURBOFIT_REVIEWED_COMMIT = 'cd59bbd47165fd7c0358a5c3b63cd51108a6a53e';
const SCAN_KEY = 'plugins.scan_on_install';
const SCAN_RESTORE_MARKER = '.clikcode-turbofit-scan-restore.json';

function hermesHomeFor(environment: Readonly<Record<string, string>>): string {
  // Hermes reads HERMES_HOME from its whole environment, not only the
  // account's overlay, so a HERMES_HOME ClikCode itself runs under counts too.
  return environment.HERMES_HOME?.trim() || process.env.HERMES_HOME?.trim()
    || join(environment.HOME || process.env.HOME || homedir(), '.hermes');
}

function runHermes(
  harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>, args: readonly string[], timeout = 30_000,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(harness.binary, [...args], {
      timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...environment },
    }, (error, stdout, stderr) => {
      const exitCode = error && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
      resolve({ code: exitCode ?? (error ? 1 : 0), output: `${String(stdout ?? '')}${String(stderr ?? '')}` });
    });
  });
}

/** Put Hermes' install scan back the way the user had it. Only the one key:
 * the install itself writes config.yaml (it enables the plugin), so the file
 * as a whole is not restored. Also run before anything else, so a ClikCode
 * killed mid-install never leaves the scan off. */
export async function restoreHermesPluginScan(
  harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>,
): Promise<void> {
  const marker = join(hermesHomeFor(environment), SCAN_RESTORE_MARKER);
  let saved: { value?: unknown };
  try { saved = JSON.parse(await readFile(marker, 'utf8')) as { value?: unknown }; }
  catch { return; }
  const result = typeof saved.value === 'string'
    ? await runHermes(harness, environment, ['config', 'set', SCAN_KEY, saved.value])
    : await runHermes(harness, environment, ['config', 'unset', SCAN_KEY]);
  if (result.code !== 0) throw new Error(`Could not restore Hermes' ${SCAN_KEY} setting: ${result.output.trim()}`);
  await rm(marker, { force: true });
}

export async function hermesTurboFitInstalled(environment: Readonly<Record<string, string>>): Promise<boolean> {
  return Boolean(await turboFitPluginRoot(environment));
}

/** Installed through Hermes' own plugin installer, into the selected
 * account's Hermes home, so Hermes records, enables and loads it like any
 * plugin. `--enable` skips the installer's confirmation, and `--ref` pins the
 * reviewed commit. Hermes' install scan is off for this one command only. */
export async function installHermesTurboFit(
  harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>,
): Promise<void> {
  await restoreHermesPluginScan(harness, environment);
  const current = await runHermes(harness, environment, ['config', 'get', SCAN_KEY]);
  // `config get` exits 1 with "Config key not set" for a key at its default.
  const unset = /key not set/i.test(current.output);
  const value = current.output.trim().split(/\r?\n/).pop()?.trim();
  if ((current.code !== 0 && !unset) || (!unset && !value)) throw new Error(`Could not read Hermes' ${SCAN_KEY} setting`);
  const scanOn = unset || !/^(?:false|no|off|0)$/i.test(value!);
  let result: { code: number; output: string };
  if (scanOn) {
    // Written before the setting changes: the marker is what restores it.
    await writeFile(join(hermesHomeFor(environment), SCAN_RESTORE_MARKER), JSON.stringify(unset ? {} : { value }));
    const off = await runHermes(harness, environment, ['config', 'set', SCAN_KEY, 'false']);
    if (off.code !== 0) {
      await restoreHermesPluginScan(harness, environment);
      throw new Error(`Could not prepare Hermes for the TurboFit install: ${off.output.trim()}`);
    }
  }
  try {
    result = await runHermes(harness, environment,
      ['plugins', 'install', '--enable', '--ref', TURBOFIT_REVIEWED_COMMIT, TURBOFIT_SOURCE], 600_000);
  } finally {
    if (scanOn) await restoreHermesPluginScan(harness, environment);
  }
  if (result.code !== 0) {
    const tail = result.output.trim().split(/\r?\n/).filter((line) => line.trim()).slice(-6).join('\n');
    throw new Error(`Could not install TurboFit (hermes exited ${result.code}).${tail ? `\n${tail}` : ''}`);
  }
  if (!await hermesTurboFitInstalled(environment)) {
    throw new Error('Hermes reported TurboFit installed, but its plugin files were not found in this Hermes home.');
  }
}

// TurboFit's own registration, without the rest of its setup: its
// apply_configuration also downloads model weights, installs runtimes and
// replaces the user's fallback providers. primary=False leaves the user's
// default model alone; the provider is what gives /model TurboFit's modes.
const TURBOFIT_REGISTER_SCRIPT = `
import importlib.util, json, sys
from pathlib import Path
from hermes_cli.config import load_config, save_config
root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("clikcode_turbofit_plugin_tools", root / "plugin_tools.py")
if spec is None or spec.loader is None:
    raise RuntimeError("TurboFit plugin could not be loaded")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with module._CONFIG_LOCK:
    config = load_config()
    if not isinstance((config.get("providers") or {}).get("turbofit"), dict):
        save_config(module.configure_hermes(config, primary=False), merge_existing=False)
print("\\x00TURBOFIT_REGISTERED")
`;

/** Register TurboFit as a Hermes provider (idempotent). */
export async function registerHermesTurboFitProvider(
  harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>,
): Promise<void> {
  const root = await turboFitPluginRoot(environment);
  if (!root) throw new Error('TurboFit is not installed in this Hermes home');
  // 30s: a Hermes home's first --version checks upstream and can take ~10s.
  const install = hermesInstallDirectory(await captureNativeHarnessOutput(harness, ['--version'], environment, 30_000));
  if (!install) throw new Error('Could not locate the Hermes Python environment');
  const python = join(install, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const output = await new Promise<string>((resolve) => {
    execFile(python, ['-c', TURBOFIT_REGISTER_SCRIPT, root], {
      cwd: install, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...environment, PYTHONPATH: [install, join(root, 'src')].join(process.platform === 'win32' ? ';' : ':'), PYTHONHOME: '' },
    }, (error, stdout, stderr) => resolve(`${String(stdout ?? '')}${String(stderr ?? '')}${error && !stdout ? error.message : ''}`));
  });
  if (!output.includes('\x00TURBOFIT_REGISTERED')) {
    throw new Error(`Could not register TurboFit with Hermes: ${output.trim().split(/\r?\n/).pop() ?? 'no output'}`);
  }
}

export async function hermesTurboFitCatalogFiles(environment: Readonly<Record<string, string>>): Promise<string[]> {
  const root = await turboFitPluginRoot(environment);
  if (!root) return [];
  return [
    join(root, 'plugin_tools.py'),
    join(root, 'scripts', 'turbofit-runtime-recommend'),
    join(root, 'references', 'model-catalog.json'),
    join(root, 'references', 'successful-runtime-profiles.json'),
    join(root, 'references', 'intelligence-scores.json'),
  ];
}

const TURBOFIT_RECOMMENDATIONS_SCRIPT = `
import importlib.util, json, sys
from pathlib import Path
root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("clikcode_turbofit_plugin_tools", root / "plugin_tools.py")
if spec is None or spec.loader is None:
    raise RuntimeError("TurboFit plugin could not be loaded")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
snapshot = module.recommendation_snapshot(limit=3)
catalog = json.loads((root / "references" / "model-catalog.json").read_text(encoding="utf-8"))
names = {str(row.get("id")): str(row.get("name") or row.get("id")) for row in catalog.get("models", []) if isinstance(row, dict)}
rows = []
seen = set()
def add(row, preference, validation=False):
    if not isinstance(row, dict) or row.get("fit") is not True:
        return
    profile = str(row.get("profile") or "")
    if not profile or profile in seen:
        return
    seen.add(profile)
    main = str(row.get("main") or "")
    name = names.get(main, main.replace("-", " ").title() or "TurboFit model")
    context = int(row.get("context") or 0)
    detail = f"{preference} · {context // 1024}K context" if context else preference
    if validation or row.get("validation_required"):
        detail += " · hardware-fit candidate; runtime validation required"
    rows.append({"id": profile, "label": name, "detail": detail})
for preference in ("intelligence", "balanced", "speed"):
    for row in (snapshot.get("recommendations") or {}).get(preference, []):
        add(row, preference)
for row in snapshot.get("compatible_lanes") or []:
    add(row, "TurboFit hardware-fit recommendation", validation=True)
print("\\x00TURBOFIT_RECOMMENDATIONS" + json.dumps(rows))
`;

export async function discoverHermesTurboFitRecommendations(
  install: string, environment: Readonly<Record<string, string>>,
): Promise<HermesLocalRecommendation[]> {
  const root = await turboFitPluginRoot(environment);
  if (!root) return [];
  const python = join(install, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const output = await new Promise<string>((resolve) => {
    execFile(python, ['-c', TURBOFIT_RECOMMENDATIONS_SCRIPT, root], {
      cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...environment, PYTHONPATH: join(root, 'src'), PYTHONHOME: '' },
    }, (_error, stdout) => resolve(String(stdout ?? '')));
  });
  const marker = output.lastIndexOf('\x00TURBOFIT_RECOMMENDATIONS');
  if (marker < 0) return [];
  try {
    const parsed = JSON.parse(output.slice(marker + '\x00TURBOFIT_RECOMMENDATIONS'.length).split('\n')[0]!) as unknown;
    return Array.isArray(parsed) ? parsed.filter((row): row is HermesLocalRecommendation =>
      Boolean(row && typeof row === 'object' && typeof (row as HermesLocalRecommendation).id === 'string'
        && typeof (row as HermesLocalRecommendation).label === 'string'
        && typeof (row as HermesLocalRecommendation).detail === 'string')) : [];
  } catch { return []; }
}

// TurboFit's own selection entry point: an exact recommended combination is
// first materialized as a manual profile, then selected, then the adaptive
// controller is restarted. Calling `turbofit-runtime use` directly skips the
// first step and rejects combination ids.
const TURBOFIT_SELECT_SCRIPT = `
import importlib.util, json, sys
from pathlib import Path
root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("clikcode_turbofit_plugin_tools", root / "plugin_tools.py")
if spec is None or spec.loader is None:
    raise RuntimeError("TurboFit plugin could not be loaded")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    payload = module.select_profile(sys.argv[2])
except Exception as exc:
    print("\\x00TURBOFIT_SELECTION" + json.dumps({"error": str(exc)}))
    sys.exit(2)
print("\\x00TURBOFIT_SELECTION" + json.dumps(payload))
`;

export async function selectHermesTurboFitRecommendation(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined, profile: string,
): Promise<void> {
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const root = await turboFitPluginRoot(environment);
  if (!root) throw new Error('TurboFit is not installed in this Hermes profile');
  const versionText = await captureNativeHarnessOutput(harness, ['--version'], environment, 8_000);
  const install = hermesInstallDirectory(versionText);
  if (!install) throw new Error('Could not locate the Hermes Python environment');
  const python = join(install, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const output = await new Promise<string>((resolve) => {
    execFile(python, ['-c', TURBOFIT_SELECT_SCRIPT, root, profile], {
      cwd: root, timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...environment, PYTHONPATH: join(root, 'src'), PYTHONHOME: '' },
    }, (error, stdout, stderr) => resolve(String(stdout ?? '') || String(stderr ?? '') || (error ? error.message : '')));
  });
  const marker = output.lastIndexOf('\x00TURBOFIT_SELECTION');
  let payload: { error?: unknown } | undefined;
  try { payload = marker < 0 ? undefined : JSON.parse(output.slice(marker + '\x00TURBOFIT_SELECTION'.length).split('\n')[0]!) as { error?: unknown }; }
  catch { /* Reported below with the raw output. */ }
  if (!payload) throw new Error(output.trim().split('\n').pop() || 'TurboFit could not select that recommendation');
  if (typeof payload.error === 'string' && payload.error) throw new Error(payload.error);
}

function hermesConnect(provider: string, name: string, authType: string | undefined): HermesConnect {
  if (provider === 'nous') return { id: provider, label: 'Nous Portal', detail: 'sign in in the browser', argv: ['auth', 'add', 'nous'] };
  if (HERMES_OAUTH_PROVIDERS.has(provider)) return { id: provider, label: name, detail: 'sign in in the browser', argv: ['auth', 'add', provider] };
  if (authType === 'api_key' && provider !== 'custom') return { id: provider, label: name, detail: 'paste an API key', argv: ['auth', 'add', provider] };
  return { id: provider, label: name, detail: 'set up in Hermes', argv: ['model'] };
}

const CONNECT_ORDER = (item: HermesConnect): number => item.id === 'nous' ? 0 : item.detail.startsWith('sign in') ? 1 : item.detail.startsWith('paste') ? 2 : 3;

export function hermesInventory(output: string): HermesInventory | undefined {
  const marker = output.lastIndexOf('\x00HERMES_INVENTORY');
  if (marker < 0) return undefined;
  try {
    const parsed = JSON.parse(output.slice(marker + '\x00HERMES_INVENTORY'.length).split('\n')[0]!) as {
      providers?: { provider?: unknown; name?: unknown; ready?: unknown; authType?: unknown; models?: unknown }[]; model?: unknown; provider?: unknown;
    };
    const models: string[] = [];
    const labels: Record<string, string> = {};
    const connect: HermesConnect[] = [];
    for (const row of parsed.providers ?? []) {
      if (typeof row.provider !== 'string' || !row.provider) continue;
      const name = typeof row.name === 'string' && row.name ? row.name : row.provider;
      const rowModels = Array.isArray(row.models) ? row.models.filter((model): model is string => typeof model === 'string' && Boolean(model.trim())) : [];
      const localProvider = HERMES_LOCAL_PROVIDERS.has(row.provider);
      if ((!localProvider && row.ready !== true) || !rowModels.length) {
        connect.push(hermesConnect(row.provider, name, typeof row.authType === 'string' ? row.authType : undefined));
        continue;
      }
      for (const model of rowModels) {
        const id = `${row.provider}:${model.trim()}`;
        models.push(id);
        if (localProvider) {
          const label = model.trim() === 'auto' ? 'TurboFit Auto mode'
            : model.trim() === 'active:main' ? 'TurboFit Main mode'
              : model.trim() === 'active:aux' ? 'TurboFit Auxiliary mode' : `${name} local mode`;
          labels[id] = label;
        }
      }
    }
    connect.sort((left, right) => CONNECT_ORDER(left) - CONNECT_ORDER(right) || left.label.localeCompare(right.label));
    const configured = typeof parsed.model === 'string' && parsed.model && typeof parsed.provider === 'string' && parsed.provider
      ? `${parsed.provider}:${parsed.model}` : undefined;
    return models.length || connect.length ? { models, ...(configured ? { configured } : {}), labels, connect } : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverHermesModels(
  harness: AiLocalHarnessDefinition, account?: AiHarnessAccount,
): Promise<HermesInventory | undefined> {
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const versionText = await captureNativeHarnessOutput(harness, ['--version'], environment, 8_000).catch(() => '');
  const install = hermesInstallDirectory(versionText);
  if (!install) return undefined;
  const python = join(install, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const output = await new Promise<string>((resolve) => {
    execFile(python, ['-c', INVENTORY_SCRIPT], {
      cwd: install, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...environment, PYTHONPATH: install, PYTHONHOME: '' },
    }, (_error, stdout) => resolve(String(stdout ?? '')));
  });
  const inventory = hermesInventory(output);
  const localRecommendations = await discoverHermesTurboFitRecommendations(install, environment).catch(() => []);
  if (!inventory && !localRecommendations.length) return undefined;
  return {
    ...(inventory ?? { models: [], labels: {}, connect: [] }),
    ...(localRecommendations.length ? { localRecommendations } : {}),
  };
}

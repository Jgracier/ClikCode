import { execFile } from 'node:child_process';
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

export interface HermesConnect { id: string; label: string; detail: string; argv: string[] }
export interface HermesInventory { models: string[]; configured?: string; labels: Record<string, string>; connect: HermesConnect[] }

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
      if (row.ready !== true || !rowModels.length) {
        connect.push(hermesConnect(row.provider, name, typeof row.authType === 'string' ? row.authType : undefined));
        continue;
      }
      for (const model of rowModels) {
        const id = `${row.provider}:${model.trim()}`;
        models.push(id);
        labels[id] = `${model.trim()} · ${name}`;
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
  return hermesInventory(output);
}

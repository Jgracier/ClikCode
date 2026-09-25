import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

/** Provider ids from `hermes_cli/auth.py`'s PROVIDER_REGISTRY. */
export function hermesProviderIds(authSource: string): string[] {
  const ids = new Set<string>();
  for (const match of authSource.matchAll(/^\s{4}"([a-z0-9-]+)":\s*ProviderConfig\(/gm)) {
    ids.add(match[1]!);
  }
  return [...ids];
}

/** `hermes --version` prints `Install directory: /path`. */
export function hermesInstallDirectory(versionText: string): string | undefined {
  return /^Install directory:\s*(.+)\s*$/m.exec(versionText)?.[1]?.trim() || undefined;
}

/** Provider ids and toolset names for the options picker. Models are read
 * with the model catalog, from the same cache. */
export async function discoverHermesChoices(
  harness: AiLocalHarnessDefinition, account?: AiHarnessAccount,
): Promise<{ providers: string[]; toolsets: string[] }> {
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const [versionText, toolsText] = await Promise.all([
    captureNativeHarnessOutput(harness, ['--version'], environment, 8_000).catch(() => ''),
    captureNativeHarnessOutput(harness, ['tools', 'list'], environment, 12_000).catch(() => ''),
  ]);
  const install = hermesInstallDirectory(versionText);
  const authSource = install ? await readFile(join(install, 'hermes_cli', 'auth.py'), 'utf8').catch(() => '') : '';
  const providers = hermesProviderIds(authSource);
  try {
    const configured = JSON.parse(await captureNativeHarnessOutput(harness, ['config', 'get', 'model', '--json'], environment, 8_000)) as { provider?: unknown };
    if (typeof configured.provider === 'string' && configured.provider.trim() && !providers.includes(configured.provider.trim())) {
      providers.unshift(configured.provider.trim());
    }
  } catch { /* The registry is enough when config cannot be read. */ }
  return { providers, toolsets: hermesToolsetNames(toolsText) };
}

/** What `hermes model` and Hermes's ACP picker offer: only providers this
 * install is signed in to, each with its models. Read by asking the install's
 * own inventory, the one those pickers call; the provider cache alone also
 * holds providers whose sign-in has lapsed. Opening an ACP session would give
 * the same list but leaves an empty session in Hermes's history. */
const INVENTORY_SCRIPT = `
import json
from hermes_cli.inventory import build_models_payload, load_picker_context
p = build_models_payload(load_picker_context(), explicit_only=True, include_unconfigured=False,
    picker_hints=False, canonical_order=True, pricing=False, capabilities=False, refresh=False,
    probe_custom_providers=False, probe_current_custom_provider=False, max_models=200)
rows = []
for row in p.get("providers") or []:
    models = [m.get("id") or m.get("model") or m.get("name") if isinstance(m, dict) else m for m in row.get("models") or []]
    rows.append({"provider": row.get("slug"), "name": row.get("name"), "models": [m for m in models if m]})
print("\\x00HERMES_INVENTORY" + json.dumps({"providers": rows, "model": p.get("model"), "provider": p.get("provider")}))
`;

export interface HermesInventory { models: string[]; configured?: string; labels: Record<string, string> }

export function hermesInventory(output: string): HermesInventory | undefined {
  const marker = output.lastIndexOf('\x00HERMES_INVENTORY');
  if (marker < 0) return undefined;
  try {
    const parsed = JSON.parse(output.slice(marker + '\x00HERMES_INVENTORY'.length).split('\n')[0]!) as {
      providers?: { provider?: unknown; name?: unknown; models?: unknown }[]; model?: unknown; provider?: unknown;
    };
    const models: string[] = [];
    const labels: Record<string, string> = {};
    for (const row of parsed.providers ?? []) {
      if (typeof row.provider !== 'string' || !row.provider || !Array.isArray(row.models)) continue;
      for (const model of row.models) {
        if (typeof model !== 'string' || !model.trim()) continue;
        const id = `${row.provider}:${model.trim()}`;
        models.push(id);
        labels[id] = `${model.trim()} · ${typeof row.name === 'string' && row.name ? row.name : row.provider}`;
      }
    }
    const configured = typeof parsed.model === 'string' && parsed.model && typeof parsed.provider === 'string' && parsed.provider
      ? `${parsed.provider}:${parsed.model}` : undefined;
    return models.length ? { models, ...(configured ? { configured } : {}), labels } : undefined;
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

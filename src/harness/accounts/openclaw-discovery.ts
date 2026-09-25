import type { AiHarnessAccount, AiLocalHarnessDefinition, ModelCatalogConnect } from '../definition.js';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';

/** What an installed OpenClaw can run, read from OpenClaw itself.
 *
 * A model is `provider/model` and `agent --model` takes it whole. `models
 * list --all --refresh --json` is the catalog with an `available` flag per
 * model: true once a route has credentials, which includes a CLI that is
 * already signed in (`claude-cli/…` rides the Claude Code login). Without
 * `--refresh` and without a running Gateway the list is only the cache, so
 * the refresh is required. Providers come from the plugins that register
 * them (`plugins list --json`, `providerIds`); one with no available model is
 * offered as a sign-in, `models auth login --provider <id>`, which asks for
 * OAuth or a key itself. Checked against OpenClaw 2026.9.6. */

export interface OpenClawInventory {
  models: string[];
  configured?: string;
  labels: Record<string, string>;
  connect: ModelCatalogConnect[];
}

interface CatalogRow { key?: unknown; name?: unknown; available?: unknown; tags?: unknown }
interface PluginRow { id?: unknown; name?: unknown; enabled?: unknown; providerIds?: unknown; cliBackendIds?: unknown }

function jsonDocument(output: string): unknown {
  const start = output.indexOf('{');
  if (start < 0) return undefined;
  try { return JSON.parse(output.slice(start)); } catch { return undefined; }
}

export function openClawInventory(catalogJson: string, pluginsJson: string): OpenClawInventory | undefined {
  const catalog = jsonDocument(catalogJson) as { models?: CatalogRow[] } | undefined;
  if (!catalog || !Array.isArray(catalog.models)) return undefined;
  const models: string[] = [];
  const labels: Record<string, string> = {};
  const readyProviders = new Set<string>();
  let configured: string | undefined;
  for (const row of catalog.models) {
    if (typeof row.key !== 'string' || !row.key.includes('/')) continue;
    const tags = Array.isArray(row.tags) ? row.tags : [];
    const isDefault = tags.includes('default');
    if (isDefault) configured = row.key;
    // The default is listed even when its own row says unavailable: OpenClaw
    // routes it through whichever runtime the setup chose (a Claude CLI
    // login), and it is what a turn with no --model runs.
    if (row.available !== true && !isDefault) continue;
    models.push(row.key);
    // Only a model OpenClaw calls available makes its provider "connected":
    // the default can run through another route while the provider itself
    // still has no key.
    if (row.available === true) readyProviders.add(row.key.split('/')[0]!);
    if (typeof row.name === 'string' && row.name) labels[row.key] = row.name;
  }
  const plugins = jsonDocument(pluginsJson) as { plugins?: PluginRow[] } | undefined;
  const connect: ModelCatalogConnect[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins?.plugins ?? []) {
    if (plugin.enabled !== true || !Array.isArray(plugin.providerIds)) continue;
    const backends = new Set(Array.isArray(plugin.cliBackendIds) ? plugin.cliBackendIds : []);
    const name = typeof plugin.name === 'string' && plugin.name && !plugin.name.startsWith('@') ? plugin.name : undefined;
    for (const provider of plugin.providerIds) {
      if (typeof provider !== 'string' || !provider || backends.has(provider) || readyProviders.has(provider) || seen.has(provider)) continue;
      seen.add(provider);
      connect.push({
        id: provider,
        label: plugin.providerIds.length === 1 && name ? name : provider,
        detail: 'sign in or paste a key',
        argv: ['models', 'auth', 'login', '--provider', provider],
      });
    }
  }
  connect.sort((left, right) => left.label.localeCompare(right.label));
  return { models, ...(configured ? { configured } : {}), labels, connect };
}

export async function discoverOpenClawModels(
  harness: AiLocalHarnessDefinition, account?: AiHarnessAccount,
): Promise<OpenClawInventory | undefined> {
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const [catalogJson, pluginsJson] = await Promise.all([
    captureNativeHarnessOutput(harness, ['models', 'list', '--all', '--refresh', '--json'], environment, 60_000).catch(() => ''),
    captureNativeHarnessOutput(harness, ['plugins', 'list', '--json'], environment, 60_000).catch(() => ''),
  ]);
  return openClawInventory(catalogJson, pluginsJson);
}

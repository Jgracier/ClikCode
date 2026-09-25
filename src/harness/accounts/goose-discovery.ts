import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiLocalHarnessDefinition, ModelCatalogConnect } from '../definition.js';
import { queryAcp } from './acp-query.js';

/** Goose's providers, which of them are signed in, and their models.
 *
 * Goose has no command that lists providers; its ACP server does:
 * `_goose/unstable/providers/config/status` gives every built-in provider and
 * whether it is configured, and the two catalog methods give display names.
 * No session is opened, so nothing is left in Goose's history.
 *
 * Goose also drives other agent CLIs as providers (`claude-code`, `codex`,
 * `gemini-cli`, `cursor-agent`), signed in by that CLI's own login. Their
 * models are the ones ClikCode already lists for that harness, so a Claude
 * Code sign-in is a Goose provider with no second login. API providers take
 * their models from the models.dev cache OpenCode keeps, where the ids match.
 * Model ids are `provider/model`; the turn passes them as `--provider` and
 * `--model`. Checked against Goose 1.51. */

/** Goose provider id -> the ClikCode harness whose CLI it drives. */
export const GOOSE_DRIVEN_HARNESSES: Readonly<Record<string, string>> = {
  'claude-code': 'claude', 'claude-acp': 'claude', codex: 'codex', 'codex-acp': 'codex', 'gemini-cli': 'gemini',
  'cursor-agent': 'cursor', 'copilot-acp': 'copilot', 'amp-acp': 'amp', 'pi-acp': 'pi',
};

export interface GooseProvider { id: string; label: string; configured: boolean }

export function gooseProviders(status: unknown, ...catalogs: unknown[]): GooseProvider[] {
  const names = new Map<string, string>();
  for (const catalog of catalogs) {
    for (const entry of (catalog as { providers?: unknown[] } | undefined)?.providers ?? []) {
      const { providerId, name } = (entry ?? {}) as { providerId?: unknown; name?: unknown };
      if (typeof providerId === 'string' && typeof name === 'string' && name) names.set(providerId, name);
    }
  }
  const providers: GooseProvider[] = [];
  for (const entry of (status as { statuses?: unknown[] } | undefined)?.statuses ?? []) {
    const { providerId, isConfigured } = (entry ?? {}) as { providerId?: unknown; isConfigured?: unknown };
    if (typeof providerId !== 'string' || !providerId) continue;
    providers.push({ id: providerId, label: names.get(providerId) ?? providerId, configured: isConfigured === true });
  }
  return providers;
}

/** The COMMON providers first; the long tail follows by name. */
const COMMON = ['anthropic', 'openai', 'chatgpt_codex', 'github_copilot', 'google', 'gemini_oauth', 'openrouter', 'claude-acp', 'codex-acp', 'ollama'];

export function gooseConnect(providers: readonly GooseProvider[]): ModelCatalogConnect[] {
  const rank = (id: string): number => {
    const index = COMMON.indexOf(id);
    return index < 0 ? COMMON.length : index;
  };
  return providers
    .filter((provider) => !provider.configured)
    .map((provider) => ({
      id: provider.id, label: provider.label, detail: 'set up in goose configure',
      argv: ['configure'], hint: `choose Configure Providers, then ${provider.label}`,
    }))
    .sort((left, right) => rank(left.id) - rank(right.id) || left.label.localeCompare(right.label));
}

/** Models for an API provider from the models.dev cache, as `provider/model`. */
export function gooseModelsDevModels(cacheJson: string, providerId: string): string[] {
  try {
    const cache = JSON.parse(cacheJson) as Record<string, { models?: Record<string, unknown> }>;
    return Object.keys(cache[providerId]?.models ?? {}).map((model) => `${providerId}/${model}`);
  } catch {
    return [];
  }
}

export async function discoverGooseProviders(
  harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>,
): Promise<GooseProvider[] | undefined> {
  return queryAcp(harness.binary, harness.acp?.argv ?? ['acp'], environment, async (request) => {
    const status = await request('_goose/unstable/providers/config/status');
    const setup = await request('_goose/unstable/providers/setup/catalog/list').catch(() => undefined);
    const catalog = await request('_goose/unstable/providers/catalog/list').catch(() => undefined);
    return gooseProviders(status, setup, catalog);
  });
}

export async function modelsDevCache(): Promise<string> {
  const cacheRoot = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache');
  return readFile(join(cacheRoot, 'opencode', 'models.json'), 'utf8').catch(() => '');
}

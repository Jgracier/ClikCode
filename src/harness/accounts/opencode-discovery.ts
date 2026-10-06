import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiLocalHarnessDefinition, ModelCatalogConnect } from '../definition.js';

/** Providers OpenCode (and its fork Kilo) can sign in to but has not.
 *
 * `<cli> models` prints only models of connected providers, as
 * `provider/model`. Every provider the CLI knows is in its models.dev cache,
 * `~/.cache/<cli>/models.json`, keyed by provider id with a display `name`.
 * The difference is what the model picker offers to connect, with the CLI's
 * own `auth login --provider <id>`, which asks for OAuth or a key itself.
 * Checked against opencode 1.18.31 and kilo 7.7.6. */

/** The providers most people mean, first; the long tail follows by name. */
const COMMON = ['anthropic', 'openai', 'github-copilot', 'google', 'openrouter', 'xai', 'deepseek', 'groq', 'mistral', 'amazon-bedrock', 'azure'];

export function opencodeConnect(cacheJson: string, connectedModels: readonly string[]): ModelCatalogConnect[] {
  let cache: Record<string, { id?: unknown; name?: unknown; env?: unknown }>;
  try { cache = JSON.parse(cacheJson) as typeof cache; } catch { return []; }
  if (!cache || typeof cache !== 'object') return [];
  const connected = new Set(connectedModels.map((model) => model.split('/')[0]!));
  const connect: ModelCatalogConnect[] = [];
  for (const [id, provider] of Object.entries(cache)) {
    if (!id || connected.has(id) || !provider || typeof provider !== 'object') continue;
    const name = typeof provider.name === 'string' && provider.name ? provider.name : id;
    const keyed = Array.isArray(provider.env) && provider.env.length > 0;
    connect.push({ id, label: name, detail: keyed ? 'sign in or paste a key' : 'sign in', argv: ['auth', 'login', '--provider', id] });
  }
  const rank = (item: ModelCatalogConnect): number => {
    const index = COMMON.indexOf(item.id);
    return index < 0 ? COMMON.length : index;
  };
  return connect.sort((left, right) => rank(left) - rank(right) || left.label.localeCompare(right.label));
}

export async function discoverOpencodeConnect(
  harness: AiLocalHarnessDefinition, connectedModels: readonly string[],
): Promise<ModelCatalogConnect[]> {
  const cacheRoot = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache');
  const cacheJson = await readFile(join(cacheRoot, harness.binary, 'models.json'), 'utf8').catch(() => '');
  return cacheJson ? opencodeConnect(cacheJson, connectedModels) : [];
}

/** `<cli> models --verbose`: each model's `provider/model` line, then its
 * metadata as JSON. A model is free when the vendor says so: Kilo's
 * `isFree` (its zero-priced routers `kilo-auto/balanced` are not), else a
 * zero input and output price (OpenCode Zen's free models carry no flag;
 * `big-pickle` has no `-free` in its id either). Checked 2026-10-06 against
 * a real paid refusal and a free answer on each. */
export function opencodeVerboseModels(raw: string): { models: string[]; free: string[] } {
  const models: string[] = [];
  const free: string[] = [];
  const blocks = raw.replace(/\u001b\[[0-9;]*m/g, '').split(/^([^\s{}"]+\/\S+)[ \t]*$/m);
  for (let index = 1; index < blocks.length; index += 2) {
    const id = blocks[index]!;
    models.push(id);
    let meta: { isFree?: unknown; cost?: { input?: unknown; output?: unknown } };
    try { meta = JSON.parse(blocks[index + 1] ?? '') as typeof meta; } catch { continue; }
    const isFree = typeof meta.isFree === 'boolean' ? meta.isFree : meta.cost?.input === 0 && meta.cost?.output === 0;
    if (isFree) free.push(id);
  }
  return { models, free };
}

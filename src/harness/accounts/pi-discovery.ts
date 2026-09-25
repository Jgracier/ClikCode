import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AiLocalHarnessDefinition, ModelCatalogConnect } from '../definition.js';
import { resolveBinaryPath } from '../transport/native/binary.js';

/** Pi's models and the providers it can sign in to.
 *
 * `pi --list-models` prints a table -- `provider  model  context ...` -- of
 * models whose provider is signed in, and with none it prints a notice with
 * two documentation paths. The generic reader kept the first column (the
 * provider, never a model) and took the paths for model ids. Pi accepts
 * `--model provider/id`, so each row becomes exactly that.
 *
 * Pi signs in only inside its own session (`/login <provider>`), so the
 * connect list opens Pi and says what to type. Its providers are the model
 * catalogs its bundled pi-ai ships, one `<id>.models.js` per provider, read
 * from the install rather than written down here. Checked against Pi 0.86. */

export function piModels(listing: string): string[] {
  const models: string[] = [];
  const lines = listing.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*provider\s+model\b/.test(line));
  if (header < 0) return models;
  for (const line of lines.slice(header + 1)) {
    const [provider, model] = line.trim().split(/\s+/);
    if (provider && model) models.push(`${provider}/${model}`);
  }
  return models;
}

/** The COMMON providers first, as OpenCode's list does. */
const COMMON = ['anthropic', 'openai-codex', 'openai', 'github-copilot', 'google', 'xai', 'openrouter', 'deepseek', 'mistral', 'groq'];

export function piConnect(
  providers: readonly { id: string; label: string }[], connectedModels: readonly string[],
): ModelCatalogConnect[] {
  const connected = new Set(connectedModels.map((model) => model.split('/')[0]!));
  const rank = (id: string): number => {
    const index = COMMON.indexOf(id);
    return index < 0 ? COMMON.length : index;
  };
  return providers
    .filter((provider) => !connected.has(provider.id))
    .map((provider) => ({ id: provider.id, label: provider.label, detail: 'sign in inside Pi', argv: [], hint: `type /login ${provider.id}` }))
    .sort((left, right) => rank(left.id) - rank(right.id) || left.label.localeCompare(right.label));
}

/** The provider's display name from its pi-ai module: the first `name:` that
 * is not the API-key variant ("Anthropic", not "Anthropic API key"). */
export function piProviderLabel(source: string, id: string): string {
  for (const match of source.matchAll(/\bname:\s*"([^"]+)"/g)) {
    if (!/api key$/i.test(match[1]!)) return match[1]!;
  }
  return id;
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory(), () => false);
}

/** pi-ai's providers directory, found from the pi binary's own package. */
async function piProvidersDirectory(harness: AiLocalHarnessDefinition): Promise<string | undefined> {
  const binary = await resolveBinaryPath(harness.binary);
  if (!binary) return undefined;
  let directory = dirname(await realpath(binary).catch(() => binary));
  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of [
      join(directory, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers'),
      join(directory, '..', 'pi-ai', 'dist', 'providers'),
    ]) {
      if (await isDirectory(candidate)) return candidate;
    }
    directory = dirname(directory);
  }
  return undefined;
}

export async function discoverPiProviders(harness: AiLocalHarnessDefinition): Promise<{ id: string; label: string }[]> {
  const directory = await piProvidersDirectory(harness);
  if (!directory) return [];
  const ids = (await readdir(directory)).filter((name) => name.endsWith('.models.js')).map((name) => name.slice(0, -'.models.js'.length));
  return Promise.all(ids.map(async (id) => ({
    id, label: piProviderLabel(await readFile(join(directory, `${id}.js`), 'utf8').catch(() => ''), id),
  })));
}

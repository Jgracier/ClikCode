/** Aider's models: those of the providers it has a key for.
 *
 * Aider runs whatever LiteLLM can reach, so its "model list" is the list of
 * the provider behind each key it finds -- in the environment, or in
 * `~/.aider/oauth-keys.env`, where its OpenRouter sign-in writes one.
 *
 * - OpenRouter: OpenRouter's own live list (public, no key needed), as
 *   `openrouter/<id>`. Aider's bundled list lags it by months; an id Aider's
 *   tables do not know still runs, and ClikCode hides the warning.
 * - Every other provider: `aider --list-models <provider>/`, filtered to names
 *   that START with the provider (Aider matches anywhere: `openai/` also
 *   returned `baseten/openai/...`).
 *
 * The old discovery, `aider --list-models ""`, listed nothing and, run in the
 * user's folder, created a git repository and a chat history file there. The
 * listing now runs in a scratch directory with `--no-git`. Checked against
 * Aider 0.86.2. */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiLocalHarnessDefinition, ModelCatalogConnect } from '../definition.js';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { atomicWriteFile } from '../../session/store/files.js';
import { stateDirectory } from '../../session/store/paths.js';

/** The key Aider reads for each provider, and the prefix of its models. */
export const AIDER_PROVIDERS: readonly { env: string; prefix: string; label: string }[] = [
  { env: 'OPENROUTER_API_KEY', prefix: 'openrouter/', label: 'OpenRouter' },
  { env: 'ANTHROPIC_API_KEY', prefix: 'anthropic/', label: 'Anthropic' },
  { env: 'OPENAI_API_KEY', prefix: 'openai/', label: 'OpenAI' },
  { env: 'DEEPSEEK_API_KEY', prefix: 'deepseek/', label: 'DeepSeek' },
  { env: 'GEMINI_API_KEY', prefix: 'gemini/', label: 'Gemini' },
  { env: 'VERTEXAI_PROJECT', prefix: 'vertex_ai/', label: 'Vertex AI' },
];

/** `KEY="value"` lines of an env file, as Aider writes oauth-keys.env. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (match && match[2]!.trim()) values[match[1]!] = match[2]!.trim();
  }
  return values;
}

/** Model names from `aider --list-models` output that belong to `prefix`. */
export function aiderListedModels(output: string, prefix: string): string[] {
  return output.split(/\r?\n/)
    .map((line) => /^- (\S+)\s*$/.exec(line)?.[1])
    .filter((model): model is string => Boolean(model?.startsWith(prefix)));
}

/** OpenRouter's live list as Aider names it, with display names. */
export function openRouterModels(json: string): { models: string[]; labels: Record<string, string> } {
  try {
    const data = (JSON.parse(json) as { data?: { id?: unknown; name?: unknown }[] }).data ?? [];
    const models: string[] = [];
    const labels: Record<string, string> = {};
    for (const entry of data) {
      if (typeof entry.id !== 'string' || !entry.id) continue;
      models.push(`openrouter/${entry.id}`);
      if (typeof entry.name === 'string' && entry.name) labels[`openrouter/${entry.id}`] = entry.name;
    }
    return { models, labels };
  } catch {
    return { models: [], labels: {} };
  }
}

export function openRouterCacheFile(): string {
  return join(stateDirectory(), 'openrouter-models.json');
}

/** OpenRouter's list, kept a day: a server's list, so a clock is the rule. */
async function openRouterList(): Promise<string> {
  const file = openRouterCacheFile();
  const kept = await stat(file).catch(() => undefined);
  if (kept && Date.now() - kept.mtimeMs < 24 * 60 * 60_000) return readFile(file, 'utf8').catch(() => '');
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.text();
    await atomicWriteFile(file, body).catch(() => undefined);
    return body;
  } catch {
    return kept ? readFile(file, 'utf8').catch(() => '') : '';
  }
}

/** The providers Aider has a key for, in this environment. */
export async function aiderKeyedProviders(environment: Readonly<Record<string, string>>): Promise<typeof AIDER_PROVIDERS[number][]> {
  const keys = { ...parseEnvFile(await readFile(join(homedir(), '.aider', 'oauth-keys.env'), 'utf8').catch(() => '')), ...process.env, ...environment };
  return AIDER_PROVIDERS.filter((provider) => keys[provider.env]?.trim());
}

export async function discoverAiderModels(
  harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>,
): Promise<{ models: string[]; labels: Record<string, string>; connect: ModelCatalogConnect[] }> {
  const providers = await aiderKeyedProviders(environment);
  const models: string[] = [];
  let labels: Record<string, string> = {};
  const scratch = await mkdtemp(join(tmpdir(), 'clikcode-aider-'));
  try {
    for (const provider of providers) {
      if (provider.prefix === 'openrouter/') {
        const live = openRouterModels(await openRouterList());
        if (live.models.length) {
          models.push(...live.models);
          labels = { ...labels, ...live.labels };
          continue;
        }
      }
      const printed = await captureNativeHarnessOutput(harness, ['--no-git', '--list-models', provider.prefix], environment, 20_000, scratch).catch(() => '');
      models.push(...aiderListedModels(printed, provider.prefix));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  // No key at all: Aider's one sign-in is OpenRouter's, from its own first run.
  const connect: ModelCatalogConnect[] = providers.length ? [] : [{
    id: 'openrouter', label: 'OpenRouter', detail: 'sign in with Aider', argv: harness.loginArgv ?? [], ...(harness.loginHint ? { hint: harness.loginHint } : {}),
  }];
  return { models: [...new Set(models)], labels, connect };
}

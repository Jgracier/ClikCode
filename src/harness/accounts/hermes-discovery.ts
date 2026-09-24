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

export function hermesCachedModels(cacheJson: string): string[] {
  try {
    const cache = JSON.parse(cacheJson) as Record<string, { models?: unknown }>;
    const models = new Set<string>();
    for (const bucket of Object.values(cache)) {
      if (!bucket || !Array.isArray(bucket.models)) continue;
      for (const model of bucket.models) {
        if (typeof model === 'string' && model.trim()) models.add(model.trim());
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

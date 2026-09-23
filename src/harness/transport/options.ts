/** Session `harnessOptions` for the non-argv transports.
 *
 * The structured-CLI turn builder (catalog `nativeHarnessTurnArgv`) already
 * renders declared options into argv. ACP and the Codex app-server do not go
 * through it, so before this module the options a user set with /options were
 * silently dropped for exactly the most-integrated harnesses. Pure: no I/O,
 * no harness names -- everything is read from the option declarations. */
import type { AiHarnessOptionDefinition } from '../definition.js';

const NORMALIZED_IDS = new Set(['model', 'workspace', 'effort', 'permissions']);

function renderedItems(option: AiHarnessOptionDefinition, raw: unknown): string[] {
  const items = (Array.isArray(raw) ? raw : [raw]).map((item) => String(item ?? '').trim()).filter(Boolean);
  for (const item of items) {
    if (option.values?.length && !option.values.includes(item)) throw new Error(`${option.label} must be one of ${option.values.join(', ')}`);
  }
  return items;
}

/** Declared options as extra argv for an ACP launch. Mirrors the catalog's own
 * turn-argv rendering (boolean flag, value, repeat, csv, config). Options the
 * harness does not declare are ignored here: the catalog turn builder is the
 * validating path, and a stale stored id must not take the ACP transport down. */
export function declaredOptionArgv(
  options: readonly AiHarnessOptionDefinition[], values: Readonly<Record<string, unknown>> | undefined, resumed = false,
): string[] {
  if (!values) return [];
  const declared = new Map(options.map((option) => [option.id, option]));
  const argv: string[] = [];
  for (const [id, raw] of Object.entries(values)) {
    const option = declared.get(id);
    if (!option?.argv || NORMALIZED_IDS.has(id)) continue;
    if (option.appliesTo === 'start' && resumed) continue;
    if (option.appliesTo === 'resume' && !resumed) continue;
    if (option.kind === 'boolean') {
      if (raw === true) argv.push(...option.argv);
      continue;
    }
    const items = renderedItems(option, raw);
    if (option.argvStyle === 'csv') {
      if (items.length) argv.push(...option.argv, items.join(','));
      continue;
    }
    for (const item of items) {
      argv.push(...option.argv, option.argvStyle === 'config' ? `${option.configKey}=${JSON.stringify(item)}` : item);
    }
  }
  return argv;
}

interface AppServerThreadOverrides {
  configOverrides?: Record<string, unknown>;
  extraThreadParams?: Record<string, unknown>;
  /** Stored options with no app-server equivalent, for an honest notice. */
  unmapped: string[];
}

function parseConfigValue(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; } // fail-open-ok: a bare TOML-ish string is its own value
}

/** Declared options as Codex app-server `thread/start|resume` overrides.
 *
 * Mapped (each is a documented config.toml key, so it travels as `config`):
 *   - any option whose declared argv is `--config key=value` -> that key/value
 *   - `profile`        -> config.profile
 *   - `search`         -> config['tools.web_search'] = true
 *   - `add-dir`        -> config['sandbox_workspace_write.writable_roots']
 *   - `oss`            -> config.model_provider = 'oss'
 *   - `local-provider` -> config.oss_provider
 * Not mapped, reported in `unmapped` (they are process-launch flags of
 * `codex exec` with no thread-level equivalent in the app-server protocol):
 *   `output-schema`, `worktree`, `ephemeral`, `ignore-user-config`,
 *   `ignore-rules`, `strict-config`. */
export function appServerThreadOverrides(
  options: readonly AiHarnessOptionDefinition[], values: Readonly<Record<string, unknown>> | undefined,
): AppServerThreadOverrides {
  const config: Record<string, unknown> = {};
  const unmapped: string[] = [];
  const declared = new Map(options.map((option) => [option.id, option]));
  for (const [id, raw] of Object.entries(values ?? {})) {
    const option = declared.get(id);
    if (!option || NORMALIZED_IDS.has(id) || raw === false || raw === undefined || raw === null || raw === '') continue;
    const argv = option.argv ?? [];
    const inlineConfig = argv.length === 2 && argv[0] === '--config' && argv[1]!.includes('=');
    if (inlineConfig && raw === true) {
      const [key, ...rest] = argv[1]!.split('=');
      config[key!] = parseConfigValue(rest.join('='));
    } else if (option.argvStyle === 'config' && option.configKey) {
      const items = renderedItems(option, raw);
      if (items.length) config[option.configKey] = items.length === 1 ? items[0] : items;
    } else if (id === 'profile') config.profile = renderedItems(option, raw)[0];
    else if (id === 'search' && raw === true) config['tools.web_search'] = true;
    else if (id === 'add-dir') config['sandbox_workspace_write.writable_roots'] = renderedItems(option, raw);
    else if (id === 'oss' && raw === true) config.model_provider = 'oss';
    else if (id === 'local-provider') config.oss_provider = renderedItems(option, raw)[0];
    else unmapped.push(id);
  }
  return { ...(Object.keys(config).length ? { configOverrides: config } : {}), unmapped };
}

export interface NormalizedTurnUsage {
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; totalTokens?: number;
  costUsd?: number; contextWindow?: number;
}

const finite = (...candidates: unknown[]): number | undefined =>
  candidates.find((candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate));
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** One shape for the usage payloads the transports pass through as published:
 * Codex `{ total|last: { inputTokens, … }, modelContextWindow }`, ACP
 * `{ inputTokens | input_tokens, … }`, and the structured-CLI NativeTurnUsage. */
export function normalizeTurnUsage(raw: unknown): NormalizedTurnUsage | undefined {
  const top = record(raw);
  if (!top) return undefined;
  const usage = record(top.total) ?? record(top.total_token_usage) ?? record(top.last) ?? top;
  const cost = record(top.cost);
  const result: NormalizedTurnUsage = {};
  const assign = <K extends keyof NormalizedTurnUsage>(key: K, value: number | undefined): void => { if (value !== undefined) result[key] = value; };
  assign('inputTokens', finite(usage.inputTokens, usage.input_tokens, usage.promptTokens, usage.prompt_tokens));
  assign('outputTokens', finite(usage.outputTokens, usage.output_tokens, usage.completionTokens, usage.completion_tokens));
  assign('cacheReadTokens', finite(usage.cacheReadTokens, usage.cachedInputTokens, usage.cached_input_tokens, usage.cache_read_input_tokens, usage.cachedReadTokens));
  assign('totalTokens', finite(usage.totalTokens, usage.total_tokens, usage.used));
  assign('costUsd', finite(top.totalCostUsd, top.total_cost_usd, top.costUsd, cost?.amount, usage.totalCostUsd));
  assign('contextWindow', finite(top.modelContextWindow, top.model_context_window, top.contextWindow, top.size, usage.size));
  return Object.keys(result).length ? result : undefined;
}

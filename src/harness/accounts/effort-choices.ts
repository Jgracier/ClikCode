/** Which reasoning levels a harness accepts, from the harness itself.
 *
 * The catalog carried these as constants, one list per harness, the same for
 * every model -- and they are exactly the kind of fact that moves with vendor
 * releases (Claude gained `xhigh` and `max`; Codex gained `ultra`). Worse, a
 * per-harness list is wrong per model: Codex's own models_cache.json says
 * gpt-6-luna and gpt-reserve stop at `max`, and ClikCode offered them `ultra`.
 *
 * So the vendor's own statement wins wherever it makes one:
 *
 *   codex        models_cache.json, per model: `supported_reasoning_levels`
 *                and `default_reasoning_level`.
 *   everything   its `--help`, where the effort flag's line enumerates the
 *                levels -- `(low, medium, high, xhigh, max)` for Claude Code,
 *                `none|low|medium|high|xhigh` for Cline.
 *   otherwise    the catalog, which is the verified-by-hand answer for the
 *                harnesses that publish no machine-readable one.
 *
 * Remembered under the cache policy (claude-models.ts, model-catalog.ts): a
 * file-derived answer is keyed on that file's identity, so it holds for as
 * long as the file does and not a moment longer.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { harnessBinaryIdentity } from '../transport/native/version-memo.js';

export interface EffortChoices {
  values: string[];
  /** The level the vendor uses when none is given, where it says. */
  default?: string;
  source: 'vendor-models' | 'vendor-help' | 'catalog';
}

const LEVEL = /^[a-z][a-z0-9-]{0,15}$/;

/** The levels a `--help` text lists for one flag, or none.
 *
 * Read from the flag's own lines -- the line naming it and the two after, since
 * help wraps a description -- in the shapes real CLIs print:
 *
 *   (low, medium, high, xhigh, max)                     Claude Code
 *   none|low|medium|high|xhigh                          Cline
 *   : none, minimal, low, medium, high, xhigh, max, or ultra.   Hermes, Pi
 *   [possible values: none, minimal, low, medium, ...]  Copilot (clap)
 *
 * If the declared flag is not in the help at all (Copilot accepts `--effort`
 * but documents only `--reasoning-effort`), any option line about effort,
 * reasoning or thinking is read instead.
 *
 * Prose is refused, not believed: "(e.g. low, medium, high) -- depends on the
 * model" is an example rather than a contract, and a list must contain at
 * least one of low/medium/high to count, which every effort scale does and
 * no stray comma list in a description will. */
export function parseHelpEffortChoices(help: string, flag: string): string[] {
  const lines = help.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const named = new RegExp(`(^|[\\s,\\[])${flag.replace(/-/g, '\\-')}(?=$|[\\s<=\\]])`);
  const listed = (raw: string, separator: RegExp): string[] => {
    const words = raw.split(separator).map((word) => word.trim().replace(/^["']|["']$/g, '').replace(/^or\s+/, ''))
      .filter(Boolean);
    const scale = words.length >= 2 && words.every((word) => LEVEL.test(word))
      && words.some((word) => word === 'low' || word === 'medium' || word === 'high');
    return scale ? words : [];
  };
  const fromBlock = (block: string): string[] => {
    if (/\be\.g\.|for example|depends on/i.test(block)) return [];
    const possible = /\[possible values:\s*([^\]]+)\]/i.exec(block)?.[1];
    if (possible) {
      const found = listed(possible, /\s*,\s*/);
      if (found.length) return found;
    }
    for (const [, inner] of block.matchAll(/\(([^()]{3,120})\)/g)) {
      const found = listed(inner!, /\s*,\s*|\s*\|\s*/);
      if (found.length) return found;
    }
    const piped = /(?:^|\s)([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)+)(?=[\s.,;]|$)/.exec(block)?.[1];
    if (piped) {
      const found = listed(piped, /\|/);
      if (found.length) return found;
    }
    const colon = /:\s*((?:[a-z][a-z0-9-]*\s*,\s*)+(?:or\s+)?[a-z][a-z0-9-]*)/.exec(block)?.[1];
    return colon ? listed(colon, /\s*,\s*/) : [];
  };
  const scan = (matches: (line: string) => boolean): string[] => {
    for (let at = 0; at < lines.length; at += 1) {
      if (!matches(lines[at]!)) continue;
      const found = fromBlock(lines.slice(at, at + 3).join(' ').replace(/\s+/g, ' '));
      if (found.length) return found;
    }
    return [];
  };
  const declared = scan((line) => named.test(line));
  if (declared.length) return declared;
  return scan((line) => /^\s*-/.test(line) && /effort|reasoning|thinking/i.test(line));
}

/** Codex's per-model levels, from its own models_cache.json. */
export function codexModelEffort(cacheJson: string, model: string | null | undefined): { values: string[]; default?: string } | undefined {
  try {
    const cache = JSON.parse(cacheJson) as { models?: Array<{ slug?: unknown; default_reasoning_level?: unknown; supported_reasoning_levels?: unknown }> };
    const entry = cache.models?.find((item) => item.slug === model);
    if (!entry || !Array.isArray(entry.supported_reasoning_levels)) return undefined;
    const values = entry.supported_reasoning_levels
      .map((level) => (level && typeof level === 'object' ? (level as { effort?: unknown }).effort : undefined))
      .filter((level): level is string => typeof level === 'string' && LEVEL.test(level));
    if (!values.length) return undefined;
    const fallback = typeof entry.default_reasoning_level === 'string' && values.includes(entry.default_reasoning_level)
      ? entry.default_reasoning_level : undefined;
    return { values, ...(fallback ? { default: fallback } : {}) };
  } catch {
    return undefined;
  }
}

const cache = new Map<string, { identity: string; result: EffortChoices }>();

async function fileIdentity(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${path}:${info.mtimeMs}:${info.size}`;
  } catch { return `${path}:absent`; }
}

/** The help text is read once per binary, not once per model or session. */
async function helpChoices(harness: AiLocalHarnessDefinition): Promise<string[] | undefined> {
  const flag = harness.effortArgvPrefix?.[0];
  if (!flag) return undefined;
  const identity = await harnessBinaryIdentity(harness.binary);
  if (!identity) return undefined;
  const key = `help:${harness.command}`;
  const cached = cache.get(key);
  if (cached?.identity === identity) return cached.result.values.length ? cached.result.values : undefined;
  let values: string[] = [];
  try {
    const helpArgv = harness.command === 'hermes' ? ['chat', '--help'] : ['--help'];
    values = parseHelpEffortChoices(await captureNativeHarnessOutput(harness, helpArgv, {}, 8_000), flag);
  } catch { /* fail-open-ok: no help text is the catalog's cue, not an error. */ }
  cache.set(key, { identity, result: { values, source: 'vendor-help' } });
  return values.length ? values : undefined;
}

export async function effortChoicesFor(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
  model?: string | null,
): Promise<EffortChoices> {
  if (harness.command === 'codex') {
    const root = account?.nativeProfile?.path ?? process.env.CODEX_HOME?.trim() ?? join(homedir(), '.codex');
    const path = join(root, 'models_cache.json');
    const key = `codex:${path}:${model ?? ''}`;
    const identity = await fileIdentity(path);
    const cached = cache.get(key);
    if (cached?.identity === identity) return cached.result;
    const found = codexModelEffort(await readFile(path, 'utf8').catch(() => ''), model);
    if (found) {
      const result: EffortChoices = { ...found, source: 'vendor-models' };
      cache.set(key, { identity, result });
      return result;
    }
  }
  const fromHelp = await helpChoices(harness);
  if (fromHelp) return { values: fromHelp, source: 'vendor-help' };
  return { values: [...(harness.effortValues ?? [])], source: 'catalog' };
}

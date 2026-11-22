/** Whether the installed `clikdeploy` can read `tools run --args-json -` from stdin (1.0.35 and later; 1.0.34
 * tries to parse "-" as JSON). Asked once per installed binary: the answer is cached against the binary's path and
 * modification time, so installing a newer CLI is noticed without restarting. Only a definite answer is cached: a check that
 * timed out or failed says nothing about the CLI, and the caller must not treat it as "old" (that would put a key on argv). */
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from './run-cli.js';

const STDIN_ARGS_JSON_MIN_VERSION = '1.0.35';

/** `1.0.35-g0123abcd` -> [1, 0, 35]; undefined when no version is in the text. The build hash suffix is ignored. */
function parseCliVersion(text: string): number[] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function versionAtLeast(text: string, min: string = STDIN_ARGS_JSON_MIN_VERSION): boolean {
  const have = parseCliVersion(text);
  const need = parseCliVersion(min)!;
  if (!have) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
}

function resolveOnPath(command: string): string | undefined {
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, command);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* fail-open-ok: not here */ }
  }
  return undefined;
}

/** `yes`: it reads `-` from stdin. `old`: it answered with a version too old for that. `unknown`: it could not be asked
 * (timed out, failed, or printed no version); `missing`: not on PATH. Neither is cached, so a slow first start is asked again. */
export type CliStdinSupport = 'yes' | 'old' | 'missing' | 'unknown';

const cache = new Map<string, 'yes' | 'old'>();
export const forgetCliStdinSupport = (): void => cache.clear();
/** A cold `clikdeploy` start (node, a large bundle, a busy disk) can take well over 15 s. */
const VERSION_CHECK_TIMEOUT_MS = 45_000;

export async function cliStdinSupport(command: string, signal?: AbortSignal, options: { timeoutMs?: number } = {}): Promise<CliStdinSupport> {
  const found = resolveOnPath(command);
  if (!found) return 'missing';
  let key = found;
  try { key = `${found}:${fs.statSync(found).mtimeMs}`; } catch { /* fail-open-ok: use the path alone */ }
  const known = cache.get(key);
  if (known !== undefined) return known;
  const result = await runCli(command, ['--version'], { signal, timeoutMs: options.timeoutMs ?? VERSION_CHECK_TIMEOUT_MS, maxChars: 2_000 });
  if (result.missing) return 'missing';
  if (result.code !== 0 || !parseCliVersion(result.text)) return 'unknown';
  const answer = versionAtLeast(result.text) ? 'yes' : 'old';
  cache.set(key, answer);
  return answer;
}

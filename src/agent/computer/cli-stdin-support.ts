/** Whether the installed `clikdeploy` can read `tools run --args-json -` from stdin (1.0.35 and later; 1.0.34
 * tries to parse "-" as JSON). Asked once per installed binary: the answer is cached against the binary's path and
 * modification time, so installing a newer CLI is noticed without restarting. */
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from './run-cli.js';

export const STDIN_ARGS_JSON_MIN_VERSION = '1.0.35';

/** `1.0.35-g0123abcd` -> [1, 0, 35]; undefined when no version is in the text. The build hash suffix is ignored. */
export function parseCliVersion(text: string): number[] | undefined {
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
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }
  return undefined;
}

const cache = new Map<string, boolean>();
export const forgetCliStdinSupport = (): void => cache.clear();

export async function cliReadsArgsJsonFromStdin(command: string, signal?: AbortSignal): Promise<boolean> {
  const found = resolveOnPath(command);
  if (!found) return false;
  let key = found;
  try { key = `${found}:${fs.statSync(found).mtimeMs}`; } catch { /* use the path alone */ }
  const known = cache.get(key);
  if (known !== undefined) return known;
  const result = await runCli(command, ['--version'], { signal, timeoutMs: 15_000, maxChars: 2_000 });
  const supported = !result.missing && result.code === 0 && versionAtLeast(result.text);
  cache.set(key, supported);
  return supported;
}

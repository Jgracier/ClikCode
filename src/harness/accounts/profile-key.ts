/** An API key pasted at sign-in, for a vendor that only reads its key from
 * an environment variable: kept in that account's own profile directory
 * (owner-only, like the credential files vendors write there themselves) and
 * given to the vendor as that variable whenever it runs under the profile. */

import { readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiLocalHarnessDefinition } from '../definition.js';

const FILE = '.clikcode-key.json';

/** The variables a harness reads its key from: the catalog's `authEnv` (keys
 * only, not settings like VERTEXAI_PROJECT), else its vendor's standard one,
 * each read out of the installed binary rather than guessed. */
const PROVIDER_KEY_VARIABLE: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY',
  amp: 'AMP_API_KEY',            // `amp --help`
  cursor: 'CURSOR_API_KEY',      // `cursor-agent --help`
  factory: 'FACTORY_API_KEY',    // present in the droid bundle
  'command-code': 'COMMAND_CODE_API_KEY', // satisfies cmdc's own auth gate
  antigravity: 'GEMINI_API_KEY', // with apiKeySettings (antigravity-cli#632)
};

export function keyVariables(harness: Pick<AiLocalHarnessDefinition, 'authEnv' | 'provider'>): string[] {
  const declared = (harness.authEnv ?? []).filter((name) => /_KEY$/.test(name));
  if (declared.length) return declared;
  const known = PROVIDER_KEY_VARIABLE[harness.provider];
  return known ? [known] : [];
}

/** The key variables saved in a profile; {} for none. Read on every spawn,
 * so a key replaced or removed applies to the next vendor process. */
export function readProfileKey(profilePath: string | undefined): Record<string, string> {
  if (!profilePath) return {};
  try {
    const parsed = JSON.parse(readFileSync(join(profilePath, FILE), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => /^[A-Z][A-Z0-9_]*$/.test(entry[0]) && typeof entry[1] === 'string' && entry[1].length > 0));
  } catch { return {}; } // fail-open-ok: no saved key is the usual case
}

export async function writeProfileKey(profilePath: string, variable: string, key: string): Promise<void> {
  await mkdir(profilePath, { recursive: true, mode: 0o700 });
  const file = join(profilePath, FILE);
  await writeFile(file, `${JSON.stringify({ [variable]: key })}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

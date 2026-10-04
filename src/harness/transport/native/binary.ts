/** Which executable a harness is, and whether this machine has it. */

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import type { AiHarnessInstaller, AiLocalHarnessDefinition } from '../../definition.js';

export interface NativeHarnessSpec {
  command: string;
  binary: string;
  displayName: string;
  surface?: 'terminal' | 'editor-extension';
  npmPackage?: string;
  installer?: AiHarnessInstaller;
  /** A separate ACP executable, which an install must also provide. */
  acp?: { binary?: string };
  loginArgv?: readonly string[];
  /** Screens the readers do not know, answered in order (vendor-sign-in.ts). */
  loginSteps?: readonly { when: string; send?: string; ask?: { prompt: string; secret?: boolean } }[];
  /** loginArgv where no browser is local (SSH from a phone): the vendor's
   * device-code login, because its default returns to a localhost callback a
   * phone cannot reach. */
  loginRemoteArgv?: readonly string[];
  /** See the catalog (packages/clikrouter/src/ai-local-harness.ts). */
  loginKeyCommand?: { providersArgv: readonly string[]; setArgv: readonly string[] };
  versionArgv?: readonly string[];
  /** Where the vendor keeps its credential: a sign-in is over once it is
   * written there, whatever the vendor's own screen goes on to do. */
  authFiles?: AiLocalHarnessDefinition['authFiles'];
}

export function executableNames(
  binary: string,
  platform: NodeJS.Platform = process.platform,
  pathExt = process.env.PATHEXT,
): string[] {
  if (platform !== 'win32' || extname(binary)) return [binary];
  const extensions = (pathExt || '.COM;.EXE;.BAT;.CMD').split(';').map((value) => value.trim()).filter(Boolean);
  return [binary, ...extensions.map((extension) => `${binary}${extension.startsWith('.') ? extension : `.${extension}`}`)];
}

export async function binaryOnPath(
  binary: string,
  options: { platform?: NodeJS.Platform; path?: string; pathExt?: string } = {},
): Promise<boolean> {
  return Boolean(await resolveBinaryPath(binary, options));
}

/** Where a binary actually resolves on PATH, or undefined. Same search as
 * binaryOnPath -- which is written in terms of this -- but it hands back the
 * path, so a caller can stat the file it is about to run instead of only
 * knowing that something by that name exists. */
export async function resolveBinaryPath(
  binary: string,
  options: { platform?: NodeJS.Platform; path?: string; pathExt?: string } = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const names = executableNames(binary, platform, options.pathExt ?? process.env.PATHEXT);
  const directories = isAbsolute(binary) ? [''] : (options.path ?? process.env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter);
  for (const rawDirectory of directories) {
    const directory = rawDirectory.replace(/^"|"$/g, '') || '.';
    for (const name of names) {
      const candidate = isAbsolute(name) ? name : join(directory, name);
      try {
        await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* try next candidate */ }
    }
  }
  return undefined;
}

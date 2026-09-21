/** The device's own secrets file: the loopback API token and the device key.
 * Separate from the index because it is the only part that is 0600. */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, stat } from 'node:fs/promises';
import { atomicWriteFile, cloneData, withStateLock } from '../store.js';
import { harnessSecretsPath } from './paths.js';

export function sameSecret(left: string | undefined, right: string | undefined): boolean {
  const a = Buffer.from(left ?? '', 'utf8');
  const b = Buffer.from(right ?? '', 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Defaults a brand-new session is built from. Provider-specific overrides win
 * over the global defaults, which win over the hardcoded fallback — replacing
 * the old behavior of silently copying whatever the previous session happened
 * to have (a one-off read-only session would otherwise make the *next* new
 * chat read-only too, with no setting anywhere explaining why). */

export interface HarnessSecrets { localApiToken?: string; devicePrivateKeyPem?: string }

export async function readSecretsFile(): Promise<HarnessSecrets> {
  const path = harnessSecretsPath();
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) await chmod(path, 0o600).catch(() => undefined);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as HarnessSecrets;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeSecretsFile(secrets: HarnessSecrets): Promise<void> {
  await atomicWriteFile(harnessSecretsPath(), `${JSON.stringify(cloneData(secrets), null, 2)}\n`);
}

/** Bearer secret for the loopback protocol, created on first use. */
export async function readLocalApiToken(): Promise<string> {
  const existing = (await readSecretsFile()).localApiToken;
  if (existing) return existing;
  return withStateLock(async () => {
    const current = await readSecretsFile();
    if (current.localApiToken) return current.localApiToken;
    const localApiToken = randomBytes(32).toString('base64url');
    await writeSecretsFile({ ...current, localApiToken });
    return localApiToken;
  });
}


// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

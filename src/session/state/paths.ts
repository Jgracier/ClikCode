/** Where ClikCode's state lives on disk, and the two questions everything
 * else asks about it: does a file exist, and what time is it now. */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirectory } from '../store.js';

/** On-disk layout version. 1 = single harness-state.json, 2 = split layout. */
export const HARNESS_STATE_VERSION = 2;

export const LOCAL_HARNESS_PROTOCOL = 1;

/** Path of the version-1 single-file state. Callers use its directory as the
 * state root; since version 2 nothing is stored at this exact path (a file
 * found here is migrated and renamed aside). It held secrets, so it was never
 * "non-secret state" as an earlier comment claimed. */
export function harnessStatePath(): string {
  return join(stateDirectory(), 'harness-state.json');
}

export function harnessIndexPath(): string {
  return join(stateDirectory(), 'index.json');
}

export function harnessSecretsPath(): string {
  return join(stateDirectory(), 'secrets.json');
}

export function harnessCommand(): string {
  return process.argv[1]?.includes('clikcode') || process.argv[1]?.includes('index-clikcode')
    ? 'clikcode'
    : 'clikdeploy ai';
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

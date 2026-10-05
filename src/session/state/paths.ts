/** Where ClikCode's state files live on disk. */

import { join } from 'node:path';
import { stateDirectory } from '../store/paths.js';

/** On-disk layout version. 1 = single harness-state.json, 2 = split layout. */
export const HARNESS_STATE_VERSION = 2;

export const LOCAL_HARNESS_PROTOCOL = 1;

/** Path of the version-1 single-file state. Callers use its directory as the
 * state root; since version 2 nothing reads or writes this exact path. */
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
  return 'clikcode';
}

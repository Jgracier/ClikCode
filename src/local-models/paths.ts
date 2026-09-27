/** Where ClikCode Local keeps what it downloads and what it knows about this
 * machine. Everything lives under one directory so removing it removes all
 * of it; the environment override exists for tests and for users who keep
 * models on a bigger disk. */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function localModelsHome(): string {
  return process.env.CLIKCODE_LOCAL_MODELS_HOME || join(homedir(), '.clikcode', 'local-models');
}

export function runtimesDir(): string { return join(localModelsHome(), 'runtimes'); }
export function modelsDir(): string { return join(localModelsHome(), 'models'); }
/** One directory per running model: its supervisor's record, its leases, its log. */
export function serversDir(): string { return join(localModelsHome(), 'servers'); }
export function measurementsFile(): string { return join(localModelsHome(), 'measurements.json'); }
export function preferencesFile(): string { return join(localModelsHome(), 'preferences.json'); }

/** A file-name-safe form of an id that may come from a user or a session. */
export function safeName(value: string): string {
  return value.replace(/[^\w.-]/g, '_');
}

import { emitJson } from './structured-output';
import { globalFlag } from './global-flags';

export function isHumanOutputRequested(): boolean {
  return globalFlag('human') || process.env.CLIKDEPLOY_OUTPUT_MODE === 'human';
}

export function isJsonOutputRequested(): boolean {
  return globalFlag('json') || process.env.CLIKDEPLOY_OUTPUT_MODE === 'json';
}

/**
 * Returns true when output should be machine-readable JSON.
 * Defaults to JSON only when stdout is NOT a TTY (piped/scripted use).
 * Interactive terminal sessions default to human-readable unless --json is passed.
 */
export function isJsonDefaultMode(): boolean {
  if (isJsonOutputRequested()) return true;
  if (isHumanOutputRequested()) return false;
  return !process.stdout.isTTY;
}

export function emitResultJson(payload: unknown): boolean {
  if (!isJsonDefaultMode()) return false;
  emitJson(payload);
  return true;
}


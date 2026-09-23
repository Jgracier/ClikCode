import { globalFlag } from './flags.js';

function isJsonOutputRequested(): boolean {
  return globalFlag('json') || process.env.CLIKCODE_OUTPUT_MODE === 'json';
}

function isHumanOutputRequested(): boolean {
  return globalFlag('human') || process.env.CLIKCODE_OUTPUT_MODE === 'human';
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


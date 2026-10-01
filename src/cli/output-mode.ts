import { globalFlag } from './flags.js';

/**
 * Returns true when output should be machine-readable JSON.
 * A flag on the command line decides first (--json, --human), then
 * CLIKCODE_OUTPUT_MODE, then the default: JSON only when stdout is NOT a TTY
 * (piped/scripted use). The variable used to be read alongside the flags, so
 * CLIKCODE_OUTPUT_MODE=json overrode an explicit --human.
 */
export function isJsonDefaultMode(): boolean {
  if (globalFlag('json')) return true;
  if (globalFlag('human')) return false;
  if (process.env.CLIKCODE_OUTPUT_MODE === 'json') return true;
  if (process.env.CLIKCODE_OUTPUT_MODE === 'human') return false;
  return !process.stdout.isTTY;
}

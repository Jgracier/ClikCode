import { emitJson } from './structured-output.js';
import { globalFlag } from './flags.js';

export function isHumanOutputRequested(): boolean {
  return globalFlag('human') || process.env.CLIKDEPLOY_OUTPUT_MODE === 'human';
}

function isJsonOutputRequested(): boolean {
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

/**
 * Emit a result payload as JSON when in machine-readable mode, and — in EVERY
 * mode — make `status: 'error'` mean a non-zero process exit.
 *
 * Every command funnels its terminal result through here, so this is the one
 * place that can honour the shell contract. Without it a failed command still
 * exited 0, and `clikdeploy servers ping <dead-box> && clikdeploy deploy`
 * cheerfully deployed to a box that had just been reported unreachable.
 *
 * The exit code is set before the mode check on purpose: a human-mode failure
 * in a `&&` chain is exactly as fatal as a JSON-mode one.
 *
 * Returns true when JSON was written (callers use it to skip human rendering).
 */
export function emitResultJson(payload: unknown): boolean {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    (payload as { status?: unknown }).status === 'error'
  ) {
    process.exitCode = 1;
  }
  if (!isJsonDefaultMode()) return false;
  emitJson(payload);
  return true;
}


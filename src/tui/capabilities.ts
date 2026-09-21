/** What this terminal can be asked to do: opt-in accessibility modes and
 * whether the live-region renderer is usable at all. */

import { stdin as input, stdout as output } from 'node:process';

/** Treat any set, non-falsy value as opt-in. These are typed by hand into a
 * shell profile, so `0`/`false`/empty must mean off rather than "the variable
 * exists, therefore enabled". */
function environmentFlag(...values: (string | undefined)[]): boolean {
  const value = values.find((candidate) => candidate !== undefined && candidate !== '');
  return value !== undefined && value !== '0' && value.toLowerCase() !== 'false';
}

/** Repainting one live region is what makes the spinner and streaming answer
 * feel immediate, and it is also exactly what a screen reader re-announces on
 * every frame. This mode routes to the existing line-oriented renderer, which
 * is append-only and therefore reads once, in order. */
export function screenReaderMode(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environmentFlag(environment.CLIKCODE_SCREEN_READER);
}

/** Holds the spinner on a single frame and slows the refresh to the rate the
 * elapsed counter actually needs. The turn still streams; only the decorative
 * motion stops. */
export function reducedMotion(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environmentFlag(environment.CLIKCODE_REDUCED_MOTION, environment.NO_MOTION);
}

export function terminalUiSupported(
  stdinTty = Boolean(input.isTTY), stdoutTty = Boolean(output.isTTY), environment: NodeJS.ProcessEnv = process.env,
): boolean {
  // `TERM=dumb` explicitly promises no cursor addressing. The line-oriented
  // fallback remains usable in CI consoles, IDE output panes, Emacs shells,
  // and other pseudo-terminals that expose a TTY without ANSI capabilities.
  if (screenReaderMode(environment)) return false;
  return stdinTty && stdoutTty && environment.TERM?.toLowerCase() !== 'dumb';
}

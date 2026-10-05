/**
 * The program-level flags (`--json`, `--human`, `--debug`), and the output
 * mode the first two decide.
 *
 * These ARE properly registered commander options on the root program, but three
 * modules used to re-scan `process.argv` for them instead of asking commander.
 * Raw-argv scanning is wrong in ways that bite:
 *   - it matches the flag after a `--` terminator, where it belongs to the
 *     child process/command payload rather than to us;
 *   - it matches a bare `--json` that is actually the *value* of a preceding
 *     option (`--message --json`), which commander would have bound correctly.
 *
 * The root program calls `bindGlobalFlags()` from its preAction hook, before any
 * action body runs. Until then (and in unit tests, which import these modules
 * without a program) we fall back to argv scanning — the same behaviour as
 * before, so nothing regresses when commander is not in the picture.
 */

interface GlobalFlags {
  json?: boolean;
  human?: boolean;
  debug?: boolean;
}

let bound: GlobalFlags | null = null;

/** Called once from the root program's preAction hook. */
export function bindGlobalFlags(opts: GlobalFlags): void {
  bound = {
    json: opts.json === true,
    human: opts.human === true,
    debug: opts.debug === true,
  };
}

/**
 * Read one global flag. Prefers commander's parse; falls back to argv only
 * while unbound, and never looks past a `--` terminator.
 */
export function globalFlag(name: keyof GlobalFlags): boolean {
  if (bound) return bound[name] === true;
  const flag = `--${name}`;
  const argv = process.argv.slice(2);
  const end = argv.indexOf('--');
  const scanned = end === -1 ? argv : argv.slice(0, end);
  return scanned.includes(flag);
}

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

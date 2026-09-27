import { stringify } from 'yaml';
import { isJsonDefaultMode } from './output-mode.js';

/**
 * A command's result, in the one shape for how it is being read.
 *
 * JSON mode (stdout is not a terminal, or `--json`) writes one compact JSON
 * record per line, so a command that reports more than once -- `sessions
 * command /codex …` says which provider it chose, then the turn -- is still
 * parseable, as JSON Lines, and a single-result command is still one JSON
 * document. Human mode (a terminal, or `--human`) writes the same data as
 * YAML: the fields, readably, with nothing dropped.
 */
export function emitResult(obj: unknown): void {
  if (isJsonDefaultMode()) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
    return;
  }
  process.stdout.write(`${stringify(obj, { lineWidth: 0 }).trimEnd()}\n`);
}

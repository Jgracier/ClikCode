/** Node's process warnings, while the full-screen UI owns the terminal.
 *
 * Node prints a warning (a listener leak, a deprecation) straight to stderr,
 * and on the alternate screen that text lands across the conversation and the
 * composer. It goes to ~/.clikcode/warnings.log instead, with its stack --
 * which is also what finds the code that caused it. */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../session/store/paths.js';

let installed = false;

export function logProcessWarnings(): void {
  if (installed || process.env.VITEST) return;
  installed = true;
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    try {
      mkdirSync(stateDirectory(), { recursive: true });
      appendFileSync(join(stateDirectory(), 'warnings.log'), `${new Date().toISOString()} pid ${process.pid} ${warning.stack ?? `${warning.name}: ${warning.message}`}\n`);
    } catch { /* fail-open-ok: a warning that cannot be logged is dropped, not printed over the UI */ }
  });
}

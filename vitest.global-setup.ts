/** Builds dist/ once, before any test file runs. Tests that spawn a real
 * worker run dist/index.js; a test file building it itself raced the others,
 * because the build clears dist/ first. CLIKCODE_TEST_SKIP_BUILD=1 keeps a
 * dist/ built beforehand (the publish build has just made one). */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  if (process.env.CLIKCODE_TEST_SKIP_BUILD === '1') return;
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: dirname(fileURLToPath(import.meta.url)), stdio: 'ignore' });
}

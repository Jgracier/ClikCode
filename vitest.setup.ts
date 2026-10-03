/** Every test file runs against its own empty home. ClikCode's state falls
 * back to ~/.clikcode whenever CLIKCODE_HOME is unset, and tests unset it --
 * restoring "nothing" after a test, or deleting it while background work
 * (model discovery) is still writing. That fallback was the real home: the
 * suite read and rewrote the user's own accounts. Pointing both HOME and
 * CLIKCODE_HOME at a temporary directory leaves no real home to fall back to.
 *
 * Every temporary directory a test makes lands inside that home too (TMPDIR,
 * which os.tmpdir() reads on each call), and the whole home goes when the
 * file's tests finish. Left behind, one run added hundreds of directories to
 * a RAM-backed /tmp, and thousands of them took the machine's memory. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'cc-t-'));
const scratch = join(root, 'tmp');
mkdirSync(scratch);
process.env.HOME = root;
process.env.CLIKCODE_HOME = join(root, '.clikcode');
process.env.TMPDIR = scratch;

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

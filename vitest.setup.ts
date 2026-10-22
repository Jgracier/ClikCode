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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'cc-t-'));
const scratch = join(root, 'tmp');
mkdirSync(scratch);
process.env.HOME = root;
process.env.CLIKCODE_HOME = join(root, '.clikcode');
process.env.TMPDIR = scratch;
process.env.CLIKCODE_LIFECYCLE_LOG = '0';
// Never the machine's own Tailscale: every list of machines asks it which
// machines the user has. This one is not running (fake-tailscale.mjs, with no
// fixture) unless a test gives it one (FAKE_TAILSCALE_STATUS).
const fakeBin = join(root, 'bin');
mkdirSync(fakeBin);
try { symlinkSync(join(__dirname, 'scripts', 'tui-e2e', 'fake-tailscale.mjs'), join(fakeBin, 'tailscale')); } catch { /* fail-open-ok: no symlinks here (Windows), and no Tailscale in its CI either */ }
process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
// Workers a test spawns are replaced for a newer build at once, not after a quiet period
// (worker-idle.ts RETIRE_QUIET_MS; worker-retire-quiet.vitest.test.ts tests the wait itself).
process.env.CLIKCODE_WORKER_RETIRE_QUIET_MS ??= '0';

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

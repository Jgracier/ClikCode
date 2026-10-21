#!/usr/bin/env node
/** A FAKE `tailscale` for ClikCode Remote's tests: `tailscale status --json`
 * prints the fixture at $FAKE_TAILSCALE_STATUS (see fake-remote.mjs
 * `tailscaleFixture`); anything else, or no fixture, fails as a tailscale
 * that is not running would. */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const fixture = process.env.FAKE_TAILSCALE_STATUS;
if (args[0] !== 'status' || !args.includes('--json') || !fixture) {
  process.stderr.write('failed to connect to local tailscaled; it doesn’t appear to be running\n');
  process.exit(1);
}
process.stdout.write(readFileSync(fixture, 'utf8'));

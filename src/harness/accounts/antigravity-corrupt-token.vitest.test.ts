import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ capture: vi.fn(), log: vi.fn() }));
vi.mock('./vendor-probe.js', async (actual) => ({ ...await actual<typeof import('./vendor-probe.js')>(), probeCommand: mocks.capture }));
vi.mock('../../runtime/lifecycle-log.js', () => ({ quiet: () => mocks.log }));
import { antigravityUsageReading } from './cli-usage-probes.js';
it('does not start vendor renewal commands when the saved credential is corrupt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agy-token-'));
  const directory = join(home, '.gemini', 'antigravity-cli');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'antigravity-oauth-token'), '{"token":{}}trailing data');
    expect(await antigravityUsageReading({ HOME: home })).toEqual({ windows: [], account: 'signed-out' });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it('never runs agy for a profile with no sign-in on disk: run signed out it starts one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agy-none-'));
  try {
    expect(await antigravityUsageReading({ HOME: home })).toBeUndefined();
    expect(mocks.capture).not.toHaveBeenCalled();
  } finally { await rm(home, { recursive: true, force: true }); }
});

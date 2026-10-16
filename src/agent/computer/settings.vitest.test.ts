import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { computerEnabled, computerEnabledSync, setComputerEnabled } from './settings.js';

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

it('keeps computer use off until the local user enables it', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-computer-'));
  expect(await computerEnabled(dir)).toBe(false);
  expect(computerEnabledSync(dir)).toBe(false);
  await setComputerEnabled(dir, true);
  expect(await computerEnabled(dir)).toBe(true);
  expect(computerEnabledSync(dir)).toBe(true);
  await setComputerEnabled(dir, false);
  expect(await computerEnabled(dir)).toBe(false);
  expect(computerEnabledSync(dir)).toBe(false);
});

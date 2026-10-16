import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { closeComputerBrowser, computerPage } from './browser.js';
import { observeComputerPage } from '../tools/computer-web.js';

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('uses an isolated Chrome profile and hides filled sign-in forms', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-computer-smoke-'));
  try {
    const page = await computerPage(stateDir);
    await page.goto('data:text/html,<label>Password <input type=password value=secret></label>');
    const result = await observeComputerPage(page, true);
    expect(result.output).toContain('Sign-in form detected');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(await computerPage(stateDir)).toBe(page);
  } finally {
    await closeComputerBrowser(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);

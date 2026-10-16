import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { closeComputerBrowser, computerPage } from './browser.js';
import { computerWebTool, observeComputerPage } from '../tools/computer-web.js';
import { setComputerEnabled } from './settings.js';
import type { ToolContext } from '../tool-contract.js';

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

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('opens, fills and clicks a real local page', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-computer-action-'));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<label>Name <input></label><button onclick="document.body.dataset.done=document.querySelector(\'input\').value">Save</button>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await setComputerEnabled(stateDir, true);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local HTTP port');
    const ctx = { stateDir, acceptsImages: false } as ToolContext;
    const run = (args: Record<string, unknown>) => computerWebTool.run(args, ctx);
    expect((await run({ action: 'open', url: `http://127.0.0.1:${address.port}/` })).output).toContain('Name');
    expect((await run({ action: 'fill', role: 'textbox', name: 'Name', text: 'Ada' })).isError).toBeUndefined();
    expect((await run({ action: 'click', role: 'button', name: 'Save' })).isError).toBeUndefined();
    expect(await (await computerPage(stateDir)).locator('body').getAttribute('data-done')).toBe('Ada');
  } finally {
    await closeComputerBrowser(stateDir);
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);

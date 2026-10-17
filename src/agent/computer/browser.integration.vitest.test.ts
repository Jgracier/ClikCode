import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { closeComputerBrowser, computerPage, openComputerPage } from './browser.js';
import { computerWebTool, observeComputerPage } from '../tools/computer-web.js';
import { setComputerEnabled } from './settings.js';
import { computerDesktopTool } from '../tools/computer.js';
import type { ToolContext } from '../tool-contract.js';

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('uses an isolated Chrome profile and hides filled sign-in forms', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-computer-smoke-'));
  try {
    const page = await openComputerPage(stateDir);
    expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
    await page.goto('data:text/html,<label>Password <input type=password value=secret></label>');
    const result = await observeComputerPage(page, true);
    expect(result.output).toContain('Sign-in fields');
    expect(JSON.stringify(result)).not.toContain('secret');
    await setComputerEnabled(stateDir, true);
    const desktop = await computerDesktopTool.run({ action: 'observe' }, { stateDir } as ToolContext);
    expect(desktop.isError).toBe(true);
    expect(desktop.output).toContain('private login');
    expect(await computerPage(stateDir)).toBe(page);
  } finally {
    await closeComputerBrowser(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('explains when another Chrome process holds the profile', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-computer-external-'));
  const external = await chromium.launchPersistentContext(join(stateDir, 'computer', 'chrome'), {
    channel: 'chrome', headless: false,
  });
  try {
    await expect(openComputerPage(stateDir)).rejects.toThrow('open outside ClikCode');
  } finally {
    await external.close();
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
    expect((await run({ action: 'observe' })).output).toContain('browser is closed');
    expect((await run({ action: 'open', url: `http://127.0.0.1:${address.port}/` })).output).toContain('Name');
    expect((await run({ action: 'fill', role: 'textbox', name: 'Name', text: 'Ada' })).isError).toBeUndefined();
    expect((await run({ action: 'click', role: 'button', name: 'Save' })).isError).toBeUndefined();
    expect(await (await computerPage(stateDir)).locator('body').getAttribute('data-done')).toBe('Ada');
    expect((await run({ action: 'close' })).output).toBe('ClikCode browser closed.');
    expect((await run({ action: 'observe' })).output).toContain('browser is closed');
  } finally {
    await closeComputerBrowser(stateDir);
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('takes a key file the site hands over as a download, through the shared browser, and leaves no file behind', async () => {
  const { captureSecret } = await import('./secret-capture.js');
  const { readNamedSecret, lockCredentialVault } = await import('./credential-vault.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-computer-download-'));
  const FILE = JSON.stringify({ type: 'service_account', client_email: 'x@example.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n' }, null, 2);
  const server = createServer((request, response) => {
    if (request.url === '/key.json') { response.setHeader('Content-Type', 'application/json'); response.setHeader('Content-Disposition', 'attachment; filename="key.json"'); response.end(FILE); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<button id="go" style="width:200px;height:50px" onclick="location.href=\'/key.json\'">Create key</button>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await setComputerEnabled(stateDir, true);
    const address = server.address() as { port: number };
    const page = await openComputerPage(stateDir);
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const result = await captureSecret({ stateDir, page, name: 'gcp/service-account-json',
      trigger: () => page.getByRole('button', { name: 'Create key' }).click(), ask: async () => { throw new Error('the person should not have been asked'); } });
    expect(result).toMatchObject({ length: FILE.length, found: true });
    expect(await readNamedSecret(stateDir, 'gcp/service-account-json')).toBe(FILE);
    // The whole file is hidden, and so is each long field inside it (the private key quoted on its own).
    const { scrubSecrets } = await import('./secret-scrubber.js');
    expect(scrubSecrets(FILE)).toBe('[secret hidden]');
    expect(scrubSecrets(`key: ${(JSON.parse(FILE) as { private_key: string }).private_key}`)).toBe('key: [secret hidden]');
  } finally {
    lockCredentialVault(stateDir);
    server.close();
    await closeComputerBrowser(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);

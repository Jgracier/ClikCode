import { access, mkdtemp, rm } from 'node:fs/promises';
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
    const opened = (await run({ action: 'open', url: `http://127.0.0.1:${address.port}/` })).output;
    expect(opened).toContain('Name');
    const ref = (role: string, name: string): string => new RegExp(`${role} "${name}" \\[ref=(\\w+)\\]`).exec(opened)![1]!;
    expect((await run({ action: 'fill', target: ref('textbox', 'Name'), text: 'Ada' })).isError).toBeUndefined();
    expect((await run({ action: 'click', target: ref('button', 'Save') })).isError).toBeUndefined();
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
    let downloaded: string | null | undefined;
    page.on('download', download => { void download.path().then(path => { downloaded = path; }); });
    const result = await captureSecret({ stateDir, page, name: 'gcp/service-account-json', check: async () => ({ verdict: 'untested', detail: 'not tested in this test' }),
      trigger: () => page.getByRole('button', { name: 'Create key' }).click(), ask: async () => { throw new Error('the person should not have been asked'); } });
    expect(result).toMatchObject({ length: FILE.length, found: true });
    expect(await readNamedSecret(stateDir, 'gcp/service-account-json')).toBe(FILE);
    // The downloaded copy is gone once it has been read.
    expect(downloaded).toBeTruthy();
    await expect(access(downloaded!)).rejects.toThrow();
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

const smoke = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
const refOf = (view: string, role: string, name: string): string => new RegExp(`${role}(?: "${name}")? \\[ref=(\\w+)\\]`).exec(view)?.[1] ?? '';

it.skipIf(!smoke)('acts on anything by reference, several steps at a time, and follows a new tab', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-computer-refs-'));
  const links = Array.from({ length: 900 }, (_, index) => `<a href="#i${index}">Item number ${index} of the long list</a>`).join('<br>');
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/second') { response.end('<title>Second</title><h1>You are on the second page</h1><button>Back office</button>'); return; }
    response.end(`<title>Start</title><header><nav><a href="#top">Menu one</a></nav></header><main><h1>Roles</h1>
      <div class="chip" onclick="document.title='chip clicked'" style="width:80px;height:30px;border:1px solid">x</div>
      <label><input type="radio" name="r" onchange="document.title='radio set'" style="opacity:0;position:absolute"><span>Inference</span></label>
      <label>Name <input id="n"></label><button onclick="document.title='saved '+document.getElementById('n').value">Save</button>
      <button onclick="window.open('/second')">Open another</button>
      <iframe srcdoc="<button onclick=&quot;parent.document.title='frame clicked'&quot;>InFrame</button>"></iframe>${links}</main>
      <dialog open aria-label="Add role"><button onclick="document.title='dialog ok'">OK</button></dialog>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await setComputerEnabled(stateDir, true);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const run = (args: Record<string, unknown>) => computerWebTool.run(args, { stateDir, acceptsImages: false } as ToolContext);
    const title = async (): Promise<string> => (await computerPage(stateDir)).title();

    // The dialog sits at the very end of a 900-link page and still comes first; the header is folded away.
    const view = (await run({ action: 'open', url: `${base}/` })).output;
    expect(view).toContain('Open now (dialogs and menus):');
    expect(view.indexOf('dialog "Add role"')).toBeLessThan(view.indexOf('heading "Roles"'));
    expect(view).toContain('lines trimmed from the middle');
    expect(view).not.toContain('Menu one');

    // An unnamed element, a visually hidden radio and a button inside a frame, all by reference.
    const chip = /generic \[ref=(e\d+)\]: x/.exec(view)?.[1];
    expect((await run({ action: 'click', target: chip })).output).toContain('Clicked');
    expect(await title()).toBe('chip clicked');
    expect((await run({ action: 'click', target: refOf(view, 'radio', 'Inference') })).isError).toBeUndefined();
    expect(await title()).toBe('radio set');
    expect((await run({ action: 'click', target: refOf(view, 'button', 'InFrame') })).isError).toBeUndefined();
    expect(await title()).toBe('frame clicked');

    // Several steps in one call, returning the page as it ends up.
    const fresh = (await run({ action: 'observe' })).output;
    const batch = await run({ action: 'steps', steps: [{ do: 'fill', target: refOf(fresh, 'textbox', 'Name'), text: 'Ada' }, { do: 'click', target: refOf(fresh, 'button', 'Save') }] });
    expect(batch.isError).toBeUndefined();
    expect(batch.output).toContain('Filled');
    expect(batch.output).toContain('Clicked');
    expect(await title()).toBe('saved Ada');

    // A step that cannot be done stops the batch, says which, and shows the page.
    const stopped = await run({ action: 'steps', steps: [{ do: 'click', target: 'e99999' }, { do: 'click', target: refOf(fresh, 'button', 'Save') }] });
    expect(stopped.isError).toBe(true);
    expect(stopped.output).toContain('Step 1 (click e99999) failed');
    expect(stopped.output).toContain('the page has changed since it was read');
    expect(stopped.output).toContain('Page: ');

    // A click that opens a new tab: that tab becomes the page, and the answer says so.
    const opened = await run({ action: 'click', target: refOf(fresh, 'button', 'Open another') });
    expect(opened.output).toContain('A new tab opened and is now the page');
    expect(opened.output).toContain('You are on the second page');
  } finally {
    await closeComputerBrowser(stateDir);
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120_000);

it.skipIf(!smoke)('waits for words to appear, and finds the lines of a long page that mention some words', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-computer-wait-'));
  const rows = Array.from({ length: 900 }, (_, index) => `<li>Row ${index}</li>`).join('');
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<main><h1>Console</h1><p id="s">Enabling the API…</p><ul>${rows}</ul><p>The special row: Compute Admin</p></main><script>setTimeout(() => { document.getElementById('s').textContent = 'API enabled'; }, 2500)</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await setComputerEnabled(stateDir, true);
    const run = (args: Record<string, unknown>) => computerWebTool.run(args, { stateDir, acceptsImages: false } as ToolContext);
    await run({ action: 'open', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` });
    const waited = await run({ action: 'wait', text: 'API enabled', seconds: 20 });
    expect(waited.isError).toBeUndefined();
    expect(waited.output).toContain('Appeared: "API enabled"');
    expect((await run({ action: 'wait', text: 'Enabling the API', gone: true, seconds: 5 })).output).toContain('Gone: "Enabling the API"');
    const never = await run({ action: 'wait', text: 'will never show', seconds: 2 });
    expect(never.isError).toBe(true);
    expect(never.output).toContain('not showing "will never show" after 2s');
    const found = (await run({ action: 'observe', find: 'compute admin' })).output;
    expect(found).toContain('Compute Admin');
    expect(found).not.toContain('Row 450');
    expect((await run({ action: 'observe', find: 'zzz not here' })).output).toContain('Nothing on the page mentions');
  } finally {
    await closeComputerBrowser(stateDir);
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90_000);

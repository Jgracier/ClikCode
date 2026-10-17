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

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('uses an isolated Chrome profile, reads a sign-in form, and masks a filled password', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-computer-smoke-'));
  try {
    const page = await openComputerPage(stateDir);
    expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
    await page.goto('data:text/html,<label>Password <input type=password></label>');
    await page.locator('input').fill('hunter2-typed');
    const result = await observeComputerPage(page, true);
    expect(result.output).toContain('Password');
    expect(JSON.stringify(result)).not.toContain('hunter2-typed');
    await setComputerEnabled(stateDir, true);
    const desktop = await computerDesktopTool.run({ action: 'observe' }, { stateDir } as ToolContext);
    expect(desktop.isError).toBe(true);
    expect(desktop.output).toContain('password');
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
    expect((await run({ action: 'close' })).output).toBe("This chat's tab is closed.");
    expect((await run({ action: 'observe' })).output).toContain('no open tab');
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

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('gives each chat its own tab in the shared Chrome', async () => {
  const { spawn } = await import('node:child_process');
  const { allComputerPages } = await import('./browser.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-computer-chats-'));
  try {
    const mine = await openComputerPage(stateDir);
    await mine.goto('data:text/html,<title>chat-a</title>chat a');
    // A second chat is a second process: it must get its own tab, and neither may see the other's.
    const script = `import('${new URL('./browser.js', import.meta.url).href}').then(async m => { const p = await m.openComputerPage(${JSON.stringify(stateDir)}); await p.goto('data:text/html,<title>chat-b</title>chat b'); console.log(JSON.stringify({ title: await p.title(), pages: (await m.allComputerPages(${JSON.stringify(stateDir)})).length })); process.exit(0); })`;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('npx', ['tsx', '-e', script], { env: { ...process.env, CLIKCODE_BROWSER_HOST_ENTRY: process.env.CLIKCODE_BROWSER_HOST_ENTRY ?? '' } });
      let text = ''; child.stdout.on('data', chunk => { text += String(chunk); }); child.stderr.on('data', chunk => { text += String(chunk); });
      child.on('close', () => resolve(text)); child.on('error', reject);
    });
    expect(out).toContain('"title":"chat-b"');
    expect(await (await computerPage(stateDir)).title()).toBe('chat-a');
    expect((await allComputerPages(stateDir)).length).toBeGreaterThanOrEqual(2);
  } finally {
    await closeComputerBrowser(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('reads a signup form and fills it from private prompts, masking and never showing the new password', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-computer-signup-'));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<label>First name <input name=fn></label><label>Email <input name=em type=email></label><label>Password <input name=pw type=password autocomplete=new-password></label><label>Confirm <input name=pw2 type=password autocomplete=new-password></label>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await setComputerEnabled(stateDir, true);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local HTTP port');
    const asked: { label: string; kind: string }[] = [];
    const secret = 'Zq9-correct-horse-77';
    const ctx = { stateDir, acceptsImages: false,
      requestPrivateLogin: async (_site: string, fields: readonly { key: string; label: string; kind: string }[]) => {
        asked.push(...fields.map(({ label, kind }) => ({ label, kind })));
        return Object.fromEntries(fields.map(field => [field.key, field.kind === 'password' ? secret : 'Ada']));
      } } as unknown as ToolContext;
    const run = (args: Record<string, unknown>) => computerWebTool.run(args, ctx);
    const opened = (await run({ action: 'open', url: `http://127.0.0.1:${address.port}/` })).output;
    expect(opened).not.toContain('Sign-in fields');
    const ref = (name: string): string => new RegExp(`textbox "${name}" \\[ref=(\\w+)\\]`).exec(opened)![1]!;
    const filled = await run({ action: 'steps', steps: [{ do: 'fill', target: ref('First name') }, { do: 'fill', target: ref('Email'), text: 'ada@example.com' }, { do: 'fill', target: ref('Password') }, { do: 'fill', target: ref('Confirm') }] });
    expect(asked.map(field => field.kind)).toEqual(['text', 'password', 'password']);
    expect(JSON.stringify(filled)).not.toContain(secret);
    expect((await run({ action: 'observe' })).output).not.toContain(secret);
    expect(await (await computerPage(stateDir)).locator('input[name=pw2]').inputValue()).toBe(secret);
  } finally {
    await closeComputerBrowser(stateDir);
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('fills a form from the saved profile without asking, formats the phone for the field, asks only for the rest and keeps it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-computer-profile-'));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<form><label>First name <input name=fn autocomplete=given-name></label>
      <label>Phone <input name=ph type=tel placeholder="(702) 123-4567"></label>
      <label>Company <input name=co autocomplete=organization></label>
      <label>Plan <select name=plan><option>Free</option><option>Pro</option></select></label>
      <div id=dd role=combobox tabindex=0 onclick="this.nextElementSibling.hidden=false">Pick a region</div><ul hidden><li role=option onclick="document.getElementById('dd').textContent=this.textContent;this.parentElement.hidden=true">US West</li><li role=option onclick="document.getElementById('dd').textContent=this.textContent;this.parentElement.hidden=true">US East</li></ul>
      <button id=go disabled>Continue</button></form>
      <script>const fn=document.querySelector('[name=fn]'),ph=document.querySelector('[name=ph]'),go=document.getElementById('go');
      const check=()=>{go.disabled=!(fn.value.length>1&&/^\\(\\d{3}\\) \\d{3}-\\d{4}$/.test(ph.value))};fn.addEventListener('input',check);ph.addEventListener('input',check);
      ph.addEventListener('input',()=>{const d=ph.value.replace(/\\D/g,'');if(d.length===10&&!ph.value.includes('('))ph.value='('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6)});</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await setComputerEnabled(stateDir, true);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local HTTP port');
    const { saveProfile, listProfiles } = await import('./profiles.js');
    await saveProfile(stateDir, { label: 'Personal', fields: { given_name: 'Ada', phone: '+17195550123' } });
    const asked: string[] = [];
    const ctx = { stateDir, acceptsImages: false, requestPrivateLogin: async (_site: string, fields: readonly { key: string; label: string }[]) => { asked.push(...fields.map(field => field.label)); return Object.fromEntries(fields.map(field => [field.key, 'Lovelace Ltd'])); } } as unknown as ToolContext;
    const run = (args: Record<string, unknown>) => computerWebTool.run(args, ctx);
    const opened = (await run({ action: 'open', url: `http://127.0.0.1:${address.port}/` })).output;
    const ref = (role: string, name: string): string => new RegExp(`${role} "${name}" \\[ref=(\\w+)\\]`).exec(opened)![1]!;
    const filled = await run({ action: 'steps', steps: [{ do: 'fill', target: ref('textbox', 'First name') }, { do: 'fill', target: ref('textbox', 'Phone') }, { do: 'fill', target: ref('textbox', 'Company') }] });
    expect(asked).toEqual(['Company']);
    const page = await computerPage(stateDir);
    expect(await page.locator('[name=fn]').inputValue()).toBe('Ada');
    expect(await page.locator('[name=ph]').inputValue()).toBe('(719) 555-0123');
    expect(await page.locator('#go').isDisabled()).toBe(false);
    expect(filled.output).not.toContain('is disabled');
    expect((await listProfiles(stateDir))[0]!.fields.organization).toBe('Lovelace Ltd');
    await run({ action: 'choose', target: 'Pick a region', text: 'US West' });
    expect(await page.locator('#dd').textContent()).toBe('US West');
    await run({ action: 'choose', target: 'Plan', text: 'Pro' });
    expect(await page.locator('[name=plan]').inputValue()).toBe('Pro');
    // A fix the agent makes: its own text wins, and the report says why a button stays disabled.
    await run({ action: 'fill', target: ref('textbox', 'First name'), text: 'A' });
    const report = await run({ action: 'fill', target: ref('textbox', 'Phone'), text: '12' });
    expect(report.output).toContain('"Continue" button is disabled');
  } finally {
    await closeComputerBrowser(stateDir);
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);

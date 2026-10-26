/** Files and environment actions of browser_use in real Chrome. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { useSourceBrowserHost } from './test-host-build.js';
import { closeComputerBrowser } from './browser.js';
import { computerWebTool } from '../tools/computer-web.js';
import { setComputerEnabled } from './settings.js';
import type { ToolContext } from '../tool-contract.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
// The browser host is a child process: run it from source.
beforeAll(async () => { if (enabled) await useSourceBrowserHost(); }, 60_000);

type Site = { run: (args: Record<string, unknown>) => ReturnType<typeof computerWebTool.run>; base: string; stateDir: string; cwd: string };
async function withSite<T>(handler: Parameters<typeof createServer>[1], use: (site: Site) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-files-env-'));
  const cwd = await mkdtemp(join(tmpdir(), 'clikcode-files-env-cwd-'));
  const server: Server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await setComputerEnabled(stateDir, true);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const ctx = { stateDir, cwd, sessionId: 'chat-1', acceptsImages: false } as ToolContext;
    return await use({ run: args => computerWebTool.run(args, ctx), base, stateDir, cwd });
  } finally {
    server.close();
    await closeComputerBrowser(stateDir);
    await rm(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await rm(cwd, { recursive: true, force: true });
  }
}

it.skipIf(!enabled)('saves a download to the chat folder, reports it, and lists it', async () => {
  await withSite((request, response) => {
    if (request.url === '/report.csv') { response.setHeader('Content-Type', 'text/csv'); response.setHeader('Content-Disposition', 'attachment; filename="report.csv"'); response.end('a,b\n1,2\n'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<a id="d" href="/report.csv">Get report</a>');
  }, async ({ run, base, stateDir }) => {
    const opened = (await run({ action: 'open', url: `${base}/` })).output;
    const ref = /link "Get report" \[ref=(\w+)\]/.exec(opened)![1]!;
    const clicked = await run({ action: 'click', target: ref });
    expect(clicked.output).toMatch(/Downloaded report\.csv \(8 B\) at .*report\.csv/);
    const file = /at (.*report\.csv)/.exec(clicked.output)![1]!;
    expect(file.startsWith(join(stateDir, 'computer', 'downloads'))).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('a,b\n1,2\n');
    expect((await run({ action: 'downloads' })).output).toContain('report.csv');
    // Opening the file's address directly saves it too, under a new name.
    const direct = await run({ action: 'open', url: `${base}/report.csv` });
    expect(direct.output).toContain('report (1).csv');
    await access(file);
  });
}, 60_000);

it.skipIf(!enabled)('does not keep a download that a key capture reads', async () => {
  const { captureSecret } = await import('./secret-capture.js');
  const { lockCredentialVault } = await import('./credential-vault.js');
  const { openComputerPage } = await import('./browser.js');
  const { listDownloads } = await import('./downloads.js');
  const FILE = JSON.stringify({ type: 'service_account', private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n' });
  await withSite((request, response) => {
    if (request.url === '/key.json') { response.setHeader('Content-Type', 'application/json'); response.setHeader('Content-Disposition', 'attachment; filename="key.json"'); response.end(FILE); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<button style="width:200px;height:50px" onclick="location.href=\'/key.json\'">Create key</button>');
  }, async ({ base, stateDir }) => {
    const page = await openComputerPage(stateDir);
    await page.goto(`${base}/`);
    const result = await captureSecret({ stateDir, page, name: 'gcp/service-account-json', check: async () => ({ verdict: 'untested', detail: 'not tested' }),
      trigger: () => page.getByRole('button', { name: 'Create key' }).click(), ask: async () => { throw new Error('should not ask'); } });
    expect(result).toMatchObject({ found: true });
    expect(await listDownloads(stateDir, 'chat-1')).toEqual([]);
    expect(await listDownloads(stateDir, undefined)).toEqual([]);
    lockCredentialVault(stateDir);
  });
}, 60_000);

it.skipIf(!enabled)('uploads a workspace file by path and refuses a dotfile', async () => {
  await withSite((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<label>Logo <input id="f" type="file"></label>');
  }, async ({ run, base, cwd, stateDir }) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'logo.png'), 'png-bytes');
    await writeFile(join(cwd, '.env'), 'SECRET=1');
    await run({ action: 'open', url: `${base}/` });
    const ref = 'Logo';
    const sent = await run({ action: 'upload', target: ref, text: join(cwd, 'logo.png') });
    expect(sent.isError).toBeUndefined();
    expect(sent.output).toContain('Uploaded logo.png');
    const { computerPage } = await import('./browser.js');
    const page = await computerPage(stateDir);
    expect(await page.evaluate(() => (document.querySelector('input') as HTMLInputElement).files?.[0]?.name)).toBe('logo.png');
    const refused = await run({ action: 'upload', target: ref, text: join(cwd, '.env') });
    expect(refused.isError).toBe(true);
    expect(refused.output).toMatch(/hidden/);
  });
}, 60_000);

const dialogPage = (script: string): string => `<title>start</title><button id="b" onclick="document.title = confirm('Delete everything?') ? 'deleted' : 'kept'">Delete</button><script>${script}</script>`;

it.skipIf(!enabled)('holds a dialog that arrives between actions, shows it, and answers it', async () => {
  await withSite((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>start</title><button onclick="setTimeout(() => { document.title = confirm('Send the report?') ? 'sent' : 'not sent'; }, 1000)">Later</button>
      <button onclick="setTimeout(() => { document.title += '/' + (prompt('Name?', 'anon') ?? 'null'); }, 1000)">Ask</button>`);
  }, async ({ run, base, stateDir }) => {
    const { computerPage } = await import('./browser.js');
    await run({ action: 'open', url: `${base}/` });
    await run({ action: 'click', target: 'Later' });
    await new Promise(resolve => setTimeout(resolve, 1500));
    // Anything else is told about the waiting box instead of hanging on the blocked page.
    const waiting = await run({ action: 'observe' });
    expect(waiting.output).toContain('confirm box: "Send the report?"');
    expect(waiting.output).toContain('dialog action');
    const accepted = await run({ action: 'dialog', accept_dialog: true });
    expect(accepted.output).toContain('accepted');
    const page = await computerPage(stateDir);
    expect(await page.title()).toBe('sent');
    await run({ action: 'click', target: 'Ask' });
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect((await run({ action: 'observe' })).output).toMatch(/prompt box: "Name\?" \(default answer "anon"\)/);
    expect((await run({ action: 'dialog', accept_dialog: true, text: 'Ada' })).output).toContain('accepted');
    expect(await page.title()).toBe('sent/Ada');
    expect((await run({ action: 'dialog' })).output).toContain('No dialog is waiting');
  });
}, 60_000);

it.skipIf(!enabled)('declines a confirm during a click and reports it; accepts when told', async () => {
  await withSite((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(dialogPage(''));
  }, async ({ run, base, stateDir }) => {
    const { computerPage } = await import('./browser.js');
    await run({ action: 'open', url: `${base}/` });
    const declined = await run({ action: 'click', target: 'Delete' });
    expect(declined.output).toContain('confirm: "Delete everything?" (declined)');
    expect(await (await computerPage(stateDir)).title()).toBe('kept');
    const accepted = await run({ action: 'click', target: 'Delete', accept_dialog: true });
    expect(accepted.output).toContain('(accepted)');
    expect(await (await computerPage(stateDir)).title()).toBe('deleted');
  });
}, 60_000);

it.skipIf(!enabled)('reports an alert and leaves a page that asks "leave this page?"', async () => {
  await withSite((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/next' ? '<h1>Next page</h1>' : '<button id="b" onclick="addEventListener(\'beforeunload\', e => { e.preventDefault(); e.returnValue = \'x\'; }); alert(\'Saved\')">Arm</button>');
  }, async ({ run, base }) => {
    await run({ action: 'open', url: `${base}/` });
    const armed = await run({ action: 'click', target: 'Arm' });
    expect(armed.output).toContain('alert: "Saved"');
    const left = await run({ action: 'open', url: `${base}/next` });
    expect(left.isError).toBeUndefined();
    expect(left.output).toContain('Next page');
  });
}, 60_000);

it.skipIf(!enabled)('answers HTTP Basic and Digest challenges for its origin only, once per request', async () => {
  const { createHash } = await import('node:crypto');
  const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
  const seen: string[] = [];
  await withSite((request, response) => {
    const header = request.headers.authorization ?? '';
    seen.push(`${request.url} ${header.split(' ')[0] || 'none'}`);
    if (request.url?.startsWith('/basic')) {
      if (header === `Basic ${Buffer.from('ada:s3cret').toString('base64')}`) { response.setHeader('Content-Type', 'text/html'); response.end('<h1>Basic welcome</h1>'); return; }
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="files"' }); response.end('no'); return;
    }
    if (request.url?.startsWith('/digest')) {
      const fields = Object.fromEntries([...header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(match => [match[1], match[2] ?? match[3]]));
      const expected = fields.username === 'ada' && fields.nonce === 'abc123' && fields.response === md5(`${md5('ada:files:s3cret')}:abc123:${fields.nc}:${fields.cnonce}:auth:${md5(`GET:${fields.uri}`)}`);
      if (header.startsWith('Digest') && expected) { response.setHeader('Content-Type', 'text/html'); response.end('<h1>Digest welcome</h1>'); return; }
      response.writeHead(401, { 'WWW-Authenticate': 'Digest realm="files", qop="auth", nonce="abc123", algorithm=MD5' }); response.end('no'); return;
    }
    response.setHeader('Content-Type', 'text/html'); response.end('<h1>Public</h1>');
  }, async ({ base, stateDir }) => {
    const { openComputerPage } = await import('./browser.js');
    const { enableHttpAuth, disableHttpAuth } = await import('./http-auth.js');
    const page = await openComputerPage(stateDir);
    await enableHttpAuth(page, base, { username: 'ada', password: 's3cret' });
    await page.goto(`${base}/basic`);
    expect(await page.locator('h1').innerText()).toBe('Basic welcome');
    await page.goto(`${base}/digest`);
    expect(await page.locator('h1').innerText()).toBe('Digest welcome');
    await page.goto(`${base}/public`);
    expect(await page.locator('h1').innerText()).toBe('Public');
    // A wrong password is sent once, not in a loop.
    await enableHttpAuth(page, base, { username: 'ada', password: 'wrong' });
    seen.length = 0;
    await page.goto(`${base}/basic`);
    expect(seen.filter(line => line.startsWith('/basic Basic')).length).toBe(1);
    expect(await disableHttpAuth(page)).toBe(true);
    expect(await disableHttpAuth(page)).toBe(false);
  });
}, 60_000);

it.skipIf(!enabled)('denies permissions by default and grants them per origin when asked', async () => {
  await withSite((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<h1>site</h1>');
  }, async ({ run, base, stateDir }) => {
    const { computerPage } = await import('./browser.js');
    const states = async (): Promise<Record<string, string>> => (await computerPage(stateDir)).evaluate(async () => {
      const out: Record<string, string> = {};
      for (const name of ['geolocation', 'camera', 'microphone', 'notifications', 'clipboard-read', 'clipboard-write']) {
        try { out[name] = (await navigator.permissions.query({ name: name as PermissionName })).state; } catch { out[name] = 'unsupported'; }
      }
      return out;
    });
    await run({ action: 'open', url: `${base}/` });
    expect(await states()).toMatchObject({ geolocation: 'denied', camera: 'denied', microphone: 'denied' });
    const granted = await run({ action: 'permissions', grant: ['geolocation', 'clipboard'] });
    expect(granted.isError).toBeUndefined();
    expect(granted.output).toContain('geolocation granted');
    expect(granted.output).toContain('camera denied');
    expect(await states()).toMatchObject({ geolocation: 'granted', 'clipboard-read': 'granted', 'clipboard-write': 'granted', camera: 'denied' });
    await run({ action: 'permissions', deny: 'geolocation' });
    expect(await states()).toMatchObject({ geolocation: 'denied', 'clipboard-write': 'granted' });
    // Opening the page again does not undo a decision.
    await run({ action: 'open', url: `${base}/` });
    expect(await states()).toMatchObject({ geolocation: 'denied', 'clipboard-write': 'granted' });
    const bad = await run({ action: 'permissions', grant: ['teleport'] });
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain('Use: camera');
  });
}, 60_000);

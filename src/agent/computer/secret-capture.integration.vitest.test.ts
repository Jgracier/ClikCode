/** Capturing a key from a real page in real Chrome: found on its own from the
 * site's response or new page text, never from the shared clipboard, and a
 * person asked only when it is unclear. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { lockCredentialVault, readNamedSecret } from './credential-vault.js';
import { captureSecret } from './secret-capture.js';
import { forgetSecrets, scrubSecrets, showsSecret } from './secret-scrubber.js';
import { observeComputerPage } from '../tools/computer-web.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
const KEY = 'salad_live_9f8e7d6c5b4a39281706';
const GOOGLE_STYLE = 'AQ.Zx9Kp2LmQ7vRt4YhNb6WcDfGjS8aEuI3oPxC1VnMzKq5TyBw';
const OTHER = 'salad_live_0a1b2c3d4e5f60718293';
let server: Server | undefined;
let browser: Browser | undefined;
let work = '';
let base = '';
let stateDir = '';

const page = (body: string): string => `<!doctype html><title>Keys</title><body>${body}</body>`;
const create = (id: string, handler: string): string => `<button id="${id}" style="width:200px;height:50px" onclick="${handler}">Create key</button><div id="out"></div>`;

beforeAll(async () => {
  if (!enabled) return;
  work = await mkdtemp(join(tmpdir(), 'clikcode-secret-site-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem'),
    '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  server = createServer({ key: await readFile(join(work, 'key.pem')), cert: await readFile(join(work, 'cert.pem')) }, (request, response) => {
    const path = new URL(request.url ?? '/', 'https://127.0.0.1').pathname;
    const send = (html: string, type = 'text/html'): void => { response.setHeader('content-type', type); response.end(html); };
    if (path === '/api/keys') return send(JSON.stringify({ id: 'key-1', api_key: KEY, csrf_token: 'Zx9Qw3Er7Ty1Ui5Op2As4Df6' }), 'application/json');
    // The key comes back from the site's request and is shown, with a CSRF token only in the response.
    if (path === '/from-response') return send(page(create('go', "fetch('/api/keys',{method:'POST'}).then(r=>r.json()).then(j=>{document.getElementById('out').innerHTML='<p>Copy your key, it will not be shown again.</p><code>'+j.api_key+'</code>'})")));
    // Revealed on the page by script alone, with no request.
    if (path === '/reveal') return send(page(create('go', `document.getElementById('out').innerHTML='<input readonly value=&quot;${KEY}&quot;>'`)));
    // Two equally likely candidates.
    if (path === '/two') return send(page(create('go', `document.getElementById('out').innerHTML='<code>${KEY}</code> <code>${OTHER}</code>'`)));
    // Nothing key-like appears; the only help is the site's Copy button.
    if (path === '/copy-only') return send(page(`<button id="copy" style="width:200px;height:50px" onclick="navigator.clipboard.writeText('${KEY}')">Copy</button>`));
    // A dialog like Google AI Studio's: the key beside a resource name and Copy buttons.
    if (path === '/dialog') return send(page(create('go', `document.getElementById('out').innerHTML='<p>API Key ${GOOGLE_STYLE}</p><button>Copy key to clipboard</button><p>Project name projects/831963658327</p><p>Project number 831963658327</p>'`)));
    // The key is never in the page text: only the site's own Copy button knows it. A "Copy cURL" button must not be pressed.
    if (path === '/copy-modal') return send(page(create('go', `document.getElementById('out').innerHTML='<p>Save your token</p><code>••••••••••••••••</code> <button id="curl" onclick="navigator.clipboard.writeText(&quot;curl -H wrong https://x&quot;)">Copy cURL</button> <button id="c" onclick="navigator.clipboard.writeText(&quot;${KEY}&quot;)">Copy</button>'`)));
    // An account's current key, already on the page in a masked field, beside an id that is not a key.
    if (path === '/existing') return send(page(`<p>Your API key</p><input type="password" value="${KEY}"><p>Org 3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b</p>`));
    send(page(create('go', "document.getElementById('out').textContent='done'")));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: false });
}, 60_000);

afterAll(async () => { await browser?.close(); server?.close(); if (work) await rm(work, { recursive: true, force: true }); });
afterEach(async () => { forgetSecrets(); if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; } });

async function open(path: string): Promise<Page> {
  const tab = await (await browser!.newContext({ ignoreHTTPSErrors: true })).newPage();
  await tab.goto(`${base}${path}`);
  return tab;
}
const neverAsked = (): never => { throw new Error('the person should not have been asked'); };
async function tap(tab: Page, selector: string): Promise<void> {
  const box = (await tab.locator(selector).boundingBox())!;
  await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

it.skipIf(!enabled)('finds the key from the site\'s response and the new page text, asking no one', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/from-response');
  const result = await captureSecret({ stateDir, page: tab, name: 'salad/api-key', remote: false, trigger: () => tap(tab, '#go'), ask: neverAsked, onLink: () => undefined });
  expect(result).toEqual({ length: KEY.length, found: true });
  expect(await readNamedSecret(stateDir, 'salad/api-key')).toBe(KEY);
  expect(scrubSecrets(`token ${KEY} and Zx9Qw3Er7Ty1Ui5Op2As4Df6`)).toBe('token [secret hidden] and Zx9Qw3Er7Ty1Ui5Op2As4Df6');
  // A picture of this page would show the key, so the observation withholds it.
  const seen = await observeComputerPage(tab, true);
  expect(seen.images).toBeUndefined();
  expect(seen.output).toContain('Screenshot withheld');
  expect(showsSecret(`${await tab.locator('code').innerText()}`)).toBe(true);
}, 60_000);

it.skipIf(!enabled)('finds a key that the page only reveals, with no request', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/reveal');
  const result = await captureSecret({ stateDir, page: tab, name: 'revealed', remote: false, trigger: () => tap(tab, '#go'), ask: neverAsked, onLink: () => undefined });
  expect(result.found).toBe(true);
  expect(await readNamedSecret(stateDir, 'revealed')).toBe(KEY);
}, 60_000);

it.skipIf(!enabled)('asks instead of guessing when two keys are equally likely', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/two');
  let hint = '';
  const result = await captureSecret({ stateDir, page: tab, name: 'two', remote: false, trigger: () => tap(tab, '#go'), ask: async (_n, h) => { hint = h; return KEY; }, onLink: () => undefined });
  expect(result).toEqual({ length: KEY.length, found: false });
  expect(hint).toContain('More than one');
}, 60_000);

it.skipIf(!enabled)('asks when nothing key-like appears, and saves nothing if the person cancels', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/plain');
  await expect(captureSecret({ stateDir, page: tab, name: 'nothing', remote: false, trigger: () => tap(tab, '#go'), ask: async () => undefined, onLink: () => undefined })).rejects.toThrow('cancelled');
  await expect(readNamedSecret(stateDir, 'nothing')).rejects.toThrow();
}, 60_000);

it.skipIf(!enabled)('presses the page\'s own Copy button by itself and ignores other copies on the computer', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/copy-only');
  // Elsewhere on the computer something else is copied: it must not count.
  const elsewhere = await browser!.newContext({ ignoreHTTPSErrors: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const other = await elsewhere.newPage();
  await other.goto(`${base}/plain`);
  await other.evaluate(() => navigator.clipboard.writeText('unrelated-token-0000-1111'));
  await tab.bringToFront();
  const result = await captureSecret({ stateDir, page: tab, name: 'copied', remote: false, ask: neverAsked, onLink: () => undefined });
  expect(result).toEqual({ length: KEY.length, found: true });
  expect(await readNamedSecret(stateDir, 'copied')).toBe(KEY);
}, 60_000);

it.skipIf(!enabled)('takes a pasted key', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/plain');
  const result = await captureSecret({ stateDir, page: tab, name: 'pasted', remote: false, trigger: () => tap(tab, '#go'), ask: async () => KEY, onLink: () => undefined });
  expect(result).toEqual({ length: KEY.length, found: false });
  expect(await readNamedSecret(stateDir, 'pasted')).toBe(KEY);
}, 60_000);

it.skipIf(!enabled)('takes a key the page is already showing when no button is given', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/existing');
  const result = await captureSecret({ stateDir, page: tab, name: 'current', remote: false, ask: neverAsked, onLink: () => undefined });
  expect(result).toEqual({ length: KEY.length, found: true });
  expect(await readNamedSecret(stateDir, 'current')).toBe(KEY);
}, 60_000);

it.skipIf(!enabled)('finds a key shown beside a resource name and Copy buttons, as a Google-style dialog does', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/dialog');
  const result = await captureSecret({ stateDir, page: tab, name: 'dialog', remote: false, trigger: () => tap(tab, '#go'), ask: neverAsked, onLink: () => undefined });
  expect(result).toEqual({ length: GOOGLE_STYLE.length, found: true });
  expect(await readNamedSecret(stateDir, 'dialog')).toBe(GOOGLE_STYLE);
}, 60_000);

it.skipIf(!enabled)('never shows the agent a key the page displays, before or after capture', async () => {
  const tab = await open('/dialog');
  await tap(tab, '#go');
  await tab.waitForTimeout(500);
  const seen = await observeComputerPage(tab, true);
  expect(seen.output).not.toContain(GOOGLE_STYLE);
  expect(seen.output).toContain('key-like value hidden');
  expect(seen.images).toBeUndefined();
}, 60_000);

it.skipIf(!enabled)('presses the site\'s own Copy button when the key never appears in the page text, and not the cURL one', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/copy-modal');
  const result = await captureSecret({ stateDir, page: tab, name: 'masked', remote: false, trigger: () => tap(tab, '#go'), ask: neverAsked, onLink: () => undefined });
  expect(result).toEqual({ length: KEY.length, found: true });
  expect(await readNamedSecret(stateDir, 'masked')).toBe(KEY);
}, 60_000);

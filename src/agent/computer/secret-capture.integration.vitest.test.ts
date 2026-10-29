/** Capturing a key from a real page in real Chrome: found on its own from the
 * site's response or new page text, never from the shared clipboard, and a
 * person asked only when it is unclear. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe as describe_, expect, it } from 'vitest';
import type { Destination } from './secret-destinations.js';
import { lockCredentialVault, readNamedSecret } from './credential-vault.js';
import { captureSecret as capture } from './secret-capture.js';
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

/** A 1,117-character signed token, like the personal access tokens CloudConvert and TidyCal show. */
const seg = (n: number, seed: number): string => Array.from({ length: n }, (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[(i * 7 + seed * 13 + (i * i) % 11) % 62]).join('');
const LONG = `eyJ${seg(60, 1)}.${seg(1000, 2)}.${seg(50, 3)}`;
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
    // An access key id and a secret key, each with its own Copy button, the id first.
    if (path === '/pair') return send(page(create('go', "document.getElementById('out').innerHTML=`<div><span>Access Key ID:</span><code>ABCDEFGHIJKLMNOPQRSTUV</code><button onclick=&quot;navigator.clipboard.writeText('ABCDEFGHIJKLMNOPQRSTUV')&quot;>Copy</button></div><div><span>Secret Key:</span><code>••••••••</code><button onclick=&quot;navigator.clipboard.writeText('"+KEY+"')&quot;>Copy</button></div>`")));
    // A dialog like Google AI Studio's: the key beside a resource name and Copy buttons.
    if (path === '/dialog') return send(page(create('go', `document.getElementById('out').innerHTML='<p>API Key ${GOOGLE_STYLE}</p><button>Copy key to clipboard</button><p>Project name projects/831963658327</p><p>Project number 831963658327</p>'`)));
    // The key is never in the page text: only the site's own Copy button knows it. A "Copy cURL" button must not be pressed.
    if (path === '/copy-modal') return send(page(create('go', `document.getElementById('out').innerHTML='<p>Save your token</p><code>••••••••••••••••</code> <button id="curl" onclick="navigator.clipboard.writeText(&quot;curl -H wrong https://x&quot;)">Copy cURL</button> <button id="c" onclick="navigator.clipboard.writeText(&quot;${KEY}&quot;)">Copy</button>'`)));
    // An account's current key, already on the page in a masked field, beside an id that is not a key.
    if (path === '/existing') return send(page(`<p>Your API key</p><input type="password" value="${KEY}"><p>Org 3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b</p>`));
    // Long tokens: in a textarea, wrapped over lines in a code block, and only on a Copy button.
    if (path === '/long-textarea') return send(page(create('go', `document.getElementById('out').innerHTML='<textarea>${LONG}</textarea>'`)));
    if (path === '/long-code') return send(page(create('go', `document.getElementById('out').innerHTML='<pre>${(LONG.match(/.{1,76}/g) ?? []).join('\\n')}</pre>'`)));
    if (path === '/long-copy') return send(page(`<p>Your token</p><button id="copy" style="width:200px;height:50px" onclick="navigator.clipboard.writeText('${LONG}')">Copy</button>`));
    if (path === '/long-masked') return send(page(`<input id="f" type="password" value="${LONG}"><button id="go" style="width:200px;height:50px" onclick="document.getElementById('f').type='text'">Show</button>`));
    send(page(create('go', "document.getElementById('out').textContent='done'")));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: false });
}, 60_000);

afterAll(async () => { await browser?.close(); server?.close(); if (work) await rm(work, { recursive: true, force: true }); });
const savedPath = process.env.PATH;
afterEach(async () => { process.env.PATH = savedPath; forgetSecrets(); if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; } });

async function open(path: string): Promise<Page> {
  const tab = await (await browser!.newContext({ ignoreHTTPSErrors: true })).newPage();
  await tab.goto(`${base}${path}`);
  return tab;
}
/** A saved key must name its site: the test site unless a test says otherwise. */
const captureSecret = (input: Parameters<typeof capture>[0]): ReturnType<typeof capture> => capture({ meta: { url: base }, ...input });
const neverAsked = (): never => { throw new Error('the person should not have been asked'); };
async function tap(tab: Page, selector: string): Promise<void> {
  const box = (await tab.locator(selector).boundingBox())!;
  await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

it.skipIf(!enabled)('finds the key from the site\'s response and the new page text, asking no one', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/from-response');
  const result = await captureSecret({ stateDir, page: tab, name: 'salad/api-key', trigger: () => tap(tab, '#go'), ask: neverAsked });
  expect(result).toMatchObject({ length: KEY.length, found: true });
  expect(await readNamedSecret(stateDir, 'salad/api-key')).toBe(KEY);
  expect(scrubSecrets(`token ${KEY} and Zx9Qw3Er7Ty1Ui5Op2As4Df6`)).toBe('token [secret hidden] and Zx9Qw3Er7Ty1Ui5Op2As4Df6');
  // A picture of this page would show the key, so the observation withholds it.
  const seen = await observeComputerPage(tab, true);
  expect(seen.images).toBeUndefined();
  expect(seen.output).toContain('Screenshot withheld');
  expect(showsSecret(`${await tab.locator('code').innerText()}`)).toBe(true);
}, 60_000);

for (const [route, how] of [['/long-textarea', 'a textarea'], ['/long-code', 'a code block wrapped over lines'], ['/long-masked', 'a masked field revealed by a button']] as const) {
  it.skipIf(!enabled)(`captures a ${LONG.length}-character token shown in ${how}`, async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
    const tab = await open(route);
    const result = await captureSecret({ stateDir, page: tab, name: 'long', trigger: () => tap(tab, '#go'), ask: neverAsked });
    expect(result.found).toBe(true);
    expect(await readNamedSecret(stateDir, 'long')).toBe(LONG);
  }, 60_000);
}

it.skipIf(!enabled)('captures a long token through the site\'s Copy button', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/long-copy');
  await captureSecret({ stateDir, page: tab, name: 'long', existing: false, ask: neverAsked });
  expect(await readNamedSecret(stateDir, 'long')).toBe(LONG);
}, 60_000);

it.skipIf(!enabled)('finds a key that the page only reveals, with no request', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/reveal');
  const result = await captureSecret({ stateDir, page: tab, name: 'revealed', trigger: () => tap(tab, '#go'), ask: neverAsked });
  expect(result.found).toBe(true);
  expect(await readNamedSecret(stateDir, 'revealed')).toBe(KEY);
}, 60_000);

it.skipIf(!enabled)('does not guess between two equally likely keys, and does not ask the person', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/two');
  await expect(captureSecret({ stateDir, page: tab, name: 'two', trigger: () => tap(tab, '#go'), ask: neverAsked })).rejects.toThrow('Not saved: more than one possible key is on the page');
  await expect(readNamedSecret(stateDir, 'two')).rejects.toThrow();
}, 60_000);

it.skipIf(!enabled)('saves nothing when nothing key-like appears: the agent is told, the person is not asked unless paste was requested', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/plain');
  await expect(captureSecret({ stateDir, page: tab, name: 'nothing', trigger: () => tap(tab, '#go'), ask: neverAsked })).rejects.toThrow('Not saved: the key could not be read from the page');
  await expect(captureSecret({ stateDir, page: tab, name: 'nothing', paste: true, ask: async () => undefined })).rejects.toThrow('Not saved: no key was found and none was pasted');
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
  const result = await captureSecret({ stateDir, page: tab, name: 'copied', ask: neverAsked });
  expect(result).toMatchObject({ length: KEY.length, found: true });
  expect(await readNamedSecret(stateDir, 'copied')).toBe(KEY);
}, 60_000);

it.skipIf(!enabled)('takes a pasted key', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/plain');
  const result = await captureSecret({ stateDir, page: tab, name: 'pasted', paste: true, ask: async () => KEY });
  expect(result).toMatchObject({ length: KEY.length, found: false });
  expect(await readNamedSecret(stateDir, 'pasted')).toBe(KEY);
}, 60_000);

it.skipIf(!enabled)('takes a key the page is already showing when no button is given', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/existing');
  const result = await captureSecret({ stateDir, page: tab, name: 'current', ask: neverAsked });
  expect(result).toMatchObject({ length: KEY.length, found: true });
  expect(await readNamedSecret(stateDir, 'current')).toBe(KEY);
}, 60_000);

it.skipIf(!enabled)('finds a key shown beside a resource name and Copy buttons, as a Google-style dialog does', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/dialog');
  const result = await captureSecret({ stateDir, page: tab, name: 'dialog', trigger: () => tap(tab, '#go'), ask: neverAsked });
  expect(result).toMatchObject({ length: GOOGLE_STYLE.length, found: true });
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
  const result = await captureSecret({ stateDir, page: tab, name: 'masked', trigger: () => tap(tab, '#go'), ask: neverAsked });
  expect(result).toMatchObject({ length: KEY.length, found: true });
  expect(await readNamedSecret(stateDir, 'masked')).toBe(KEY);
}, 60_000);

it.skipIf(!enabled)('takes the secret from a pair of Copy buttons, says where it came from, and never saves the id as a second secret', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/pair');
  const result = await captureSecret({ stateDir, page: tab, name: 'pair/secret', trigger: () => tap(tab, '#go'), ask: neverAsked });
  expect(result.via).toContain('next to "Secret Key"');
  expect(await readNamedSecret(stateDir, 'pair/secret')).toBe(KEY);
  // The same value again, under another name, is success: not stored twice, still sent on.
  const again = await open('/pair');
  const repeat = await captureSecret({ stateDir, page: again, name: 'pair/other', trigger: () => tap(again, '#go'), ask: neverAsked });
  expect(repeat.alreadySavedAs).toBe('pair/secret');
  await expect(readNamedSecret(stateDir, 'pair/other')).rejects.toThrow();
}, 60_000);

it.skipIf(!enabled)('refuses to save a value its own service rejects when the page already showed it, and saves one it accepts', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const refused = { verdict: 'rejected', service: 'Example', detail: 'Example refused it (HTTP 401)' } as const;
  const tab = await open('/existing');
  await expect(captureSecret({ stateDir, page: tab, name: 'refused', ask: neverAsked, check: async () => refused })).rejects.toThrow('Not saved: Example refused it');
  await expect(readNamedSecret(stateDir, 'refused')).rejects.toThrow();
  const tab2 = await open('/reveal');
  const ok = await captureSecret({ stateDir, page: tab2, name: 'accepted', trigger: () => tap(tab2, '#go'), ask: neverAsked,
    check: async () => ({ verdict: 'works', service: 'Example', detail: 'Example accepted it' }) });
  expect(ok.check.verdict).toBe('works');
  expect(await readNamedSecret(stateDir, 'accepted')).toBe(KEY);
}, 60_000);

it.skipIf(!enabled)('keeps a key it just made even when its service refuses it for now, and sends it nowhere', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const { chmod, mkdir, writeFile } = await import('node:fs/promises');
  const bin = join(work, 'bin-held');
  await mkdir(bin, { recursive: true });
  const log = join(work, 'held.log');
  await writeFile(log, '');
  await writeFile(join(bin, 'clikdeploy'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\necho '{}'\n`);
  await chmod(join(bin, 'clikdeploy'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const tab = await open('/reveal');
  const result = await captureSecret({ stateDir, page: tab, name: 'held', trigger: () => tap(tab, '#go'), ask: neverAsked,
    sendTo: [{ to: 'clikdeploy-secret', with: { key: 'SALAD_API_KEY' } }],
    check: async () => ({ verdict: 'rejected', service: 'Google', detail: 'Google refused it (invalid_grant)' }) });
  expect(result.check.verdict).toBe('rejected');
  expect(result.sent).toEqual([]);
  expect(await readNamedSecret(stateDir, 'held')).toBe(KEY);
  expect(await readFile(log, 'utf8')).toBe('');
}, 60_000);

describe_('forwarding the captured key', () => {
  async function fakeCli(script: string): Promise<{ log: string }> {
    const bin = join(work, 'bin-forward');
    await mkdir(bin, { recursive: true });
    const log = join(work, 'forward.log');
    await writeFile(log, '');
    await writeFile(join(bin, 'clikdeploy'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\n${script}\n`);
    await chmod(join(bin, 'clikdeploy'), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    return { log };
  }
  const plan: Destination[] = [{ to: 'clikdeploy-secret', with: { key: 'SALAD_API_KEY' } }];

  it.skipIf(!enabled)('captures, saves, then sends to the planned destination in one step', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
    const { log } = await fakeCli(`echo '{"status":"success","message":"stored"}'`);
    const tab = await open('/reveal');
    const result = await captureSecret({ stateDir, page: tab, name: 'forwarded', trigger: () => tap(tab, '#go'), ask: neverAsked, sendTo: plan });
    expect(result.sent).toEqual([expect.objectContaining({ ok: true, label: 'clikdeploy-secret (SALAD_API_KEY)' })]);
    expect(await readFile(log, 'utf8')).toContain(KEY);
    expect(await readNamedSecret(stateDir, 'forwarded')).toBe(KEY);
  }, 60_000);

  it.skipIf(!enabled)('sends nothing when the service refuses the key', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
    const { log } = await fakeCli(`echo '{}'`);
    const tab = await open('/reveal');
    const result = await captureSecret({ stateDir, page: tab, name: 'refused-send', trigger: () => tap(tab, '#go'), ask: neverAsked, sendTo: plan,
      check: async () => ({ verdict: 'rejected', service: 'Example', detail: 'Example refused it (HTTP 401)' }) });
    expect(result.sent).toEqual([]);
    expect(await readFile(log, 'utf8')).toBe('');
  }, 60_000);

  it.skipIf(!enabled)('keeps the key saved when a destination fails, so it can be sent again', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
    await fakeCli(`echo '{"status":"error","message":"step-up required"}'; exit 2`);
    const tab = await open('/reveal');
    const result = await captureSecret({ stateDir, page: tab, name: 'kept', trigger: () => tap(tab, '#go'), ask: neverAsked, sendTo: plan });
    expect(result.sent[0]).toMatchObject({ ok: false });
    expect(result.sent[0]!.message).toContain('step-up required');
    expect(await readNamedSecret(stateDir, 'kept')).toBe(KEY);
  }, 60_000);
});

it.skipIf(!enabled)('finishes and saves the key when it is stopped after the click that made it', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/reveal');
  const controller = new AbortController();
  const result = await captureSecret({ stateDir, page: tab, name: 'finished', signal: controller.signal, ask: neverAsked,
    trigger: async () => { await tap(tab, '#go'); controller.abort(); } });
  expect(result.length).toBe(KEY.length);
  expect(await readNamedSecret(stateDir, 'finished')).toBe(KEY);
}, 60_000);

it.skipIf(!enabled)('simply stops when it is stopped before anything was clicked', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-capture-'));
  const tab = await open('/reveal');
  const controller = new AbortController();
  controller.abort();
  await expect(captureSecret({ stateDir, page: tab, name: 'never', signal: controller.signal, ask: neverAsked })).rejects.toThrow('Not saved');
  await expect(readNamedSecret(stateDir, 'never')).rejects.toThrow();
}, 60_000);

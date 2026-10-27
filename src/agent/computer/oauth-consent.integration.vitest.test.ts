/** The generic consent driver in real Chrome against a fake multi-screen vendor and a fake ClikDeploy connect endpoint. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import http from 'node:http';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { oauthConnect } from './oauth-consent.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
let browser: Browser | undefined;
beforeAll(async () => { if (enabled) browser = await chromium.launch({ channel: 'chrome', headless: true }); }, 60_000);
afterAll(async () => { await browser?.close(); });

/** A vendor with the screens Google shows (chooser, Advanced, Go to (unsafe), Continue) or one that wants a password first. */
async function fakeWorld(mode: 'consent' | 'login' | 'granular' | 'warning') {
  let connected = false;
  let mailtoClicks = 0;
  const typed: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const html = (body: string): void => { res.writeHead(200, { 'content-type': 'text/html' }).end(`<body>${body}</body>`); };
    if (url.pathname === '/connect/slack') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', data: { authorizationUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/auth?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${(server.address() as { port: number }).port}/callback`)}&state=s1` } }));
    if (url.pathname === '/status/slack') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ connected }));
    if (url.pathname === '/callback') { connected = url.searchParams.get('code') === 'good'; return html(connected ? '<h1>Slack connected</h1><p>You can close this window.</p>' : '<h1>Connection failed</h1>'); }
    if (url.pathname === '/mailto-click') { mailtoClicks++; return void res.writeHead(204).end(); }
    if (url.pathname === '/typed') { typed.push(url.searchParams.get('v') ?? ''); return void res.writeHead(204).end(); }
    if (url.pathname !== '/auth') return void res.writeHead(404).end();
    const redirect = url.searchParams.get('redirect_uri')!, state = url.searchParams.get('state')!;
    if (mode === 'login') return html('<h1>Sign in</h1><input type="email" value="me@example.com"><input type="password" id="p"><button>Sign in</button>');
    if (mode === 'granular') return html(`<p>ClikDeploy wants access to your Google Account</p><label><input type="checkbox" id="all" onclick="for(const c of document.querySelectorAll('.sc'))c.checked=this.checked">Select all</label>
      <label><input type="checkbox" class="sc">View your activity</label><label><input type="checkbox" class="sc">View your sleep</label>
      <button onclick="location='/auth?deny=1'">Cancel</button>
      <button onclick="location='${redirect}?'+(document.querySelectorAll('.sc:checked').length===2?'code=good':'error=access_denied')+'&state=${state}'">Continue</button>`);
    // Google's "hasn't verified this app" page: the developer's address, which is the profile's, is a mailto: link beside Advanced.
    if (mode === 'warning') return html(`<div id="s1"><h1>Google hasn't verified this app</h1><p>Until the developer (<a href="mailto:me@example.com" onclick="fetch('/mailto-click');return false">me@example.com</a>) verifies this app with Google, you shouldn't use it.</p><span onclick="show(3)">Advanced</span></div>
      <div id="s2" hidden></div>
      <div id="s3" hidden><a href="#" onclick="show(4);return false">Go to Vendor (unsafe)</a></div>
      <div id="s4" hidden><p>Acme wants to access your account</p><button onclick="location='/auth?deny=1'">Deny</button><button onclick="location='${redirect}?code=good&state=${state}'">Allow</button></div>
      <script>function show(n){for(let i=1;i<=4;i++)document.getElementById('s'+i).hidden=i!==n}</script>`);
    html(`<div id="s1"><div data-identifier="me@example.com" role="link" tabindex="0" onclick="show(2)">me@example.com</div><div data-identifier="other@example.com" role="link" tabindex="0" onclick="document.title='wrong'">other@example.com</div></div>
      <div id="s2" hidden><span onclick="show(3)">Advanced</span></div>
      <div id="s3" hidden><a href="#" onclick="show(4);return false">Go to Vendor (unsafe)</a></div>
      <div id="s4" hidden><p>Acme wants to access your account</p><button onclick="location='/auth?deny=1'">Deny</button><button onclick="location='${redirect}?code=good&state=${state}'">Allow</button></div>
      <script>function show(n){for(let i=1;i<=4;i++)document.getElementById('s'+i).hidden=i!==n}</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    typed, base, mailtoClicks: () => mailtoClicks,
    start: async (id: string) => ({ url: ((await (await fetch(`${base}/connect/${id}`)).json()) as { data: { authorizationUrl: string } }).data.authorizationUrl, stop: () => undefined }),
    status: async (id: string) => ({ connected: ((await (await fetch(`${base}/status/${id}`)).json()) as { connected: boolean }).connected }),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

it.skipIf(!enabled)('chooses the named account, presses through the notices and Allow, and confirms the connection', async () => {
  const world = await fakeWorld('consent');
  try {
    const page = await browser!.newPage();
    const lines: string[] = [];
    const done = await oauthConnect('slack', page, { email: 'me@example.com', providerHost: 'accounts.google.com', start: world.start, status: world.status, timeoutMs: 40_000, progress: line => lines.push(line) });
    expect(done.connector).toBe('slack');
    expect(await page.title()).not.toBe('wrong');
    expect(lines.join('')).toContain('Chose the account');
    expect(lines.join('')).toContain('Allowed access');
    expect(await page.locator('body').innerText()).toContain('Slack connected');
  } finally { world.close(); }
}, 60_000);

it.skipIf(!enabled)('stops at a login password with a plain reason and types nothing', async () => {
  const world = await fakeWorld('login');
  try {
    const page = await browser!.newPage();
    const error = await oauthConnect('slack', page, { email: 'me@example.com', start: world.start, status: world.status, timeoutMs: 20_000 }).then(() => undefined, (e: Error) => e);
    expect(error?.message).toContain('login password');
    expect(error?.message).toContain('Nothing was typed');
    expect(error?.message).not.toContain('me@example.com');
    expect(await page.locator('#p').inputValue()).toBe('');
  } finally { world.close(); }
}, 40_000);

it.skipIf(!enabled)('ticks Select all on a granular-consent page before pressing Continue', async () => {
  const world = await fakeWorld('granular');
  try {
    const page = await browser!.newPage();
    const lines: string[] = [];
    const done = await oauthConnect('slack', page, { providerHost: 'accounts.google.com', start: world.start, status: world.status, timeoutMs: 40_000, progress: line => lines.push(line) });
    expect(done.connector).toBe('slack');
    expect(lines.join('')).toContain('Ticked the scope checkboxes');
  } finally { world.close(); }
}, 60_000);

it.skipIf(!enabled)('never presses the developer\'s email address on the unverified-app page, which is a mailto: link', async () => {
  const world = await fakeWorld('warning');
  try {
    const page = await browser!.newPage();
    const done = await oauthConnect('slack', page, { email: 'me@example.com', providerHost: 'accounts.google.com', start: world.start, status: world.status, timeoutMs: 40_000 });
    expect(done.connector).toBe('slack');
    expect(await page.locator('body').innerText()).toContain('Slack connected');
    // A press of that link would hand the address to the computer's mail program (and, with nothing to open it, a chooser).
    expect(world.mailtoClicks()).toBe(0);
  } finally { world.close(); }
}, 60_000);

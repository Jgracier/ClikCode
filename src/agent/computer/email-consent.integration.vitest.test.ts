/** The consent click-through in real Chrome against a fake Google: account chooser, unverified-app notice, Continue. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { saveNamedSecret } from './credential-vault.js';
import { EMAIL_CLIENT_SECRET, emailStatus, type GoogleEndpoints } from './email-api.js';
import { connectEmail } from './email-consent.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
let browser: Browser | undefined;
beforeAll(async () => { if (enabled) browser = await chromium.launch({ channel: 'chrome', headless: true }); }, 60_000);
afterAll(async () => { await browser?.close(); });

it.skipIf(!enabled)('chooses the named account, passes the unverified-app notice, presses Continue, and the mailbox is stored', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-consent-'));
  const fake = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (v: unknown): void => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v)); };
    if (url.pathname === '/token') return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    if (url.pathname === '/gmail/profile') return json({ emailAddress: 'me@example.com' });
    if (url.pathname !== '/auth') return void res.writeHead(404).end();
    const redirect = url.searchParams.get('redirect_uri')!, state = url.searchParams.get('state')!;
    // Three screens on one page, revealed in the order Google shows them.
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<body>
      <div id="s1"><div data-identifier="me@example.com" role="link" tabindex="0" onclick="show(2)">me@example.com</div><div data-identifier="other@example.com" role="link" tabindex="0" onclick="document.title='wrong'">other@example.com</div></div>
      <div id="s2" hidden><span onclick="show(3)">Advanced</span></div>
      <div id="s3" hidden><a href="#" onclick="show(4);return false">Go to ClikCode (unsafe)</a></div>
      <div id="s4" hidden><button onclick="location='${redirect}?code=good&state=${state}'">Continue</button></div>
      <script>function show(n){for(let i=1;i<=4;i++)document.getElementById('s'+i).hidden=i!==n}</script></body>`);
  });
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve));
  const port = (fake.address() as { port: number }).port;
  const endpoints: GoogleEndpoints = { auth: `http://127.0.0.1:${port}/auth`, token: `http://127.0.0.1:${port}/token`, gmail: `http://127.0.0.1:${port}/gmail` };
  try {
    await saveNamedSecret(dir, EMAIL_CLIENT_SECRET, JSON.stringify({ clientId: 'cid', clientSecret: 'cs' }));
    const page = await browser!.newPage();
    const lines: string[] = [];
    const done = await connectEmail(dir, page, { email: 'me@example.com', endpoints, timeoutMs: 40_000, progress: line => lines.push(line) });
    expect(done.email).toBe('me@example.com');
    expect(await page.title()).not.toBe('wrong');
    expect((await emailStatus(dir)).connected).toBe(true);
    expect(lines.join('')).toContain('Chose the account');
  } finally { fake.closeAllConnections(); fake.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

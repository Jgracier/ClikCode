/** A "Sign in with Google" button that opens Google's chooser in a popup (also from inside an iframe, and after a delay) is followed and
 * completed in real Chrome against a local fixture. Google's address is served by the test itself. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import http from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { followPopup } from './google-popup.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
let browser: Browser | undefined;
let server: http.Server | undefined;
let base = '';
beforeAll(async () => {
  if (!enabled) return;
  server = http.createServer((req, res) => {
    const open = `window.open('https://accounts.google.com/o/oauth2/v2/auth?client_id=x','google','width=500,height=600')`;
    const page = (body: string): void => { res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Site</title><body>${body}<script>window.addEventListener('message',e=>{document.title=e.data})</script></body>`); };
    if (req.url === '/direct') return page(`<button onclick="${open}">Sign in with Google</button>`);
    if (req.url === '/delayed') return page(`<button onclick="fetch('/ping').then(()=>setTimeout(()=>{${open}},800))">Sign in with Google</button>`);
    if (req.url === '/framed') return page(`<iframe name="gsi" style="width:300px;height:80px" srcdoc="<button onclick=&quot;${open.replace(/'/g, '&#39;')}&quot;>Sign in with Google</button><script>addEventListener('message',e=>parent.postMessage(e.data,'*'))</script>"></iframe>`);
    if (req.url === '/password') return page(`<button onclick="${open.replace('client_id=x', 'client_id=password')}">Sign in with Google</button>`);
    if (req.url === '/ping') return void res.writeHead(204).end();
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); server?.close(); });

/** Google, as far as the popup can tell: a chooser, then a consent screen whose Continue hands back to the opener and closes. */
async function withGoogle(context: BrowserContext): Promise<void> {
  await context.route('https://accounts.google.com/**', route => {
    const url = new URL(route.request().url());
    const html = (body: string): Promise<void> => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body>${body}</body>` });
    if (url.searchParams.get('client_id') === 'password') return html('<h1>Welcome</h1><p>To continue, first verify it\'s you</p><input type="password"><button>Next</button>');
    if (url.pathname === '/o/oauth2/v2/auth') return html(`<h1>Choose an account</h1><p>to continue to Site</p>
      <div role="link" tabindex="0" onclick="location='/signin/oauth/v3/consent'">Someone Else<div>other@example.com</div></div>
      <div role="link" tabindex="0" onclick="location='/signin/oauth/v3/consent'">Justin Gracier<div>me@example.com</div></div>`);
    if (url.pathname === '/signin/oauth/v3/consent') return html(`<h1>Site wants additional access to your Google Account</h1>
      <button onclick="window.close()">Cancel</button><button onclick="window.opener.postMessage('signed in','*');window.close()">Continue</button>`);
    return route.fulfill({ status: 404, body: '' });
  });
}

async function signIn(path: string, click: (page: Page) => Promise<void>): Promise<{ page: Page; opener: Page; note?: string }> {
  const context = await browser!.newContext();
  await withGoogle(context);
  const opener = await context.newPage();
  await opener.goto(`${base}${path}`);
  const popup = opener.waitForEvent('popup', { timeout: 10_000 });
  await click(opener);
  const outcome = await followPopup(opener, await popup, { email: 'me@example.com', timeoutMs: 20_000 });
  return { ...outcome, opener };
}

for (const [path, how, click] of [
  ['/direct', 'a button', (p: Page) => p.getByRole('button', { name: 'Sign in with Google' }).click()],
  ['/delayed', 'a button that fetches before it opens the window', (p: Page) => p.getByRole('button', { name: 'Sign in with Google' }).click()],
  ['/framed', 'a button inside an iframe', (p: Page) => p.frameLocator('iframe').getByRole('button', { name: 'Sign in with Google' }).click()],
] as const) {
  it.skipIf(!enabled)(`follows the Google popup opened by ${how}, chooses the account, presses Continue and hands back to the opener`, async () => {
    const result = await signIn(path, click);
    expect(result.page).toBe(result.opener);
    expect(result.note).toMatch(/completed/);
    await expect.poll(() => result.opener.title()).toBe('signed in');
    await result.opener.context().close();
  }, 60_000);
}

it.skipIf(!enabled)('stops at a Google password screen, types nothing and leaves the popup as the current page', async () => {
  const result = await signIn('/password', p => p.getByRole('button', { name: 'Sign in with Google' }).click());
  expect(result.page).not.toBe(result.opener);
  expect(result.note).toMatch(/stopped at a login password/);
  expect(await result.page.locator('input[type=password]').inputValue()).toBe('');
  await result.opener.context().close();
}, 60_000);

it.skipIf(!enabled)('leaves a popup that is not Google alone', async () => {
  const context = await browser!.newContext();
  const opener = await context.newPage();
  await opener.goto(`${base}/direct`);
  const popup = opener.waitForEvent('popup');
  await opener.evaluate(() => { (globalThis as unknown as { open(url: string): void }).open('about:blank#plain'); });
  const outcome = await followPopup(opener, await popup);
  expect(outcome.page).not.toBe(opener);
  expect(outcome.note).toBeUndefined();
  await context.close();
}, 60_000);

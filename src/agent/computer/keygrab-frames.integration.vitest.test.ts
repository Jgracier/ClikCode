/** The page reader and the tool's click/fill reach into same-origin and cross-origin iframes, in real Chrome (the HERE sign-up form lives in a frame). Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { locate } from '../tools/computer-web.js';
import { lookAt } from './keygrab-live.js';

const SKIP = process.env.CLIKCODE_COMPUTER_SMOKE !== '1';
const serve = (html: (url: string) => string): Promise<http.Server> => new Promise(resolve => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html(req.url ?? '/')); });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

it.skipIf(SKIP)('reads and acts inside same-origin and cross-origin iframes', async () => {
  const form = await serve(() => '<h2>Verify your identity</h2><p>A verification email will follow.</p><label>Work email <input id="mail"></label><button onclick="document.title=\'sent\'">Request access</button>');
  const formPort = (form.address() as AddressInfo).port;
  const host = await serve(url => url === '/inner' ? '<label>Full name <input></label><button>Create account</button>' : `<h1>HERE sign up</h1><iframe src="/inner" width="500" height="200"></iframe><iframe src="http://localhost:${formPort}/" width="500" height="260"></iframe>`);
  const hostPort = (host.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${hostPort}/`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    const view = await lookAt(page);
    expect(view.text).toContain('HERE sign up');
    expect(view.text).toContain('A verification email will follow');
    expect(view.fields).toEqual(expect.arrayContaining(['Full name', 'Work email']));
    expect(view.controls.filter(c => c.frame).map(c => c.name)).toEqual(expect.arrayContaining(['Create account', 'Request access']));
    await (await locate(page, 'Work email')).fill('someone@example.com');
    await (await locate(page, 'Request access')).click();
    const crossFrame = page.frames().find(f => f.url().includes(`:${formPort}`))!;
    expect(await crossFrame.evaluate(() => (globalThis as unknown as { document: { title: string } }).document.title)).toBe('sent');
    expect(await crossFrame.locator('#mail').inputValue()).toBe('someone@example.com');
  } finally {
    await browser.close();
    form.close(); host.close();
  }
}, 60_000);

it.skipIf(SKIP)('reads controls and fields inside open shadow roots (a web-component sign-up form)', async () => {
  const host = await serve(() => '<h1>Verify your identity</h1><sign-up></sign-up><script>const r = document.querySelector("sign-up").attachShadow({mode:"open"}); r.innerHTML = "<style>.x{color:red}</style><label>First name <input placeholder=\\"First name\\"></label><label>Email <input placeholder=\\"Email address\\"></label><button>Verify email</button>";</script>');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(host.address() as AddressInfo).port}/`);
    const view = await lookAt(page);
    expect(view.fields).toEqual(expect.arrayContaining(['First name', 'Email']));
    expect(view.controls.map(c => c.name)).toContain('Verify email');
    expect(view.text).not.toContain('color:red');
    await (await locate(page, 'Email')).fill('someone@example.com');
  } finally {
    await browser.close();
    host.close();
  }
}, 60_000);

it.skipIf(SKIP)('does not offer a mailto: link, or text inside one, as something to press', async () => {
  const server = await serve(() => '<p>Until the developer (<a href="mailto:me@example.com">me@example.com</a>) verifies this app, you shouldn\'t use it. <a href="tel:+15555550100"><span>Call us</span></a></p><a href="/help">Help center</a><button>Advanced</button>');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const names = (await lookAt(page)).controls.map(control => control.name);
    expect(names).toContain('Help center');
    expect(names).toContain('Advanced');
    expect(names).not.toContain('me@example.com');
    expect(names).not.toContain('Call us');
  } finally { await browser.close(); server.close(); }
}, 40_000);

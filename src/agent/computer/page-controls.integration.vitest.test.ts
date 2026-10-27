/** The shared control reader in real Chrome: skips mailto:/tel: links (and text inside them), reads open shadow roots, and reads iframes through lookAt. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { lookAt } from './keygrab-live.js';

const SKIP = process.env.CLIKCODE_COMPUTER_SMOKE !== '1';
const serve = (html: (url: string) => string): Promise<http.Server> => new Promise(resolve => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html(req.url ?? '/')); });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

it.skipIf(SKIP)('skips mailto:/tel: links and spans inside them, reads shadow roots and iframes', async () => {
  const body = '<a href="mailto:me@example.com">me@example.com</a> <a href="tel:+15555550100"><span>Call us</span></a> <a href="/help">Help center</a> <button>Advanced</button><shadow-box></shadow-box><script>const r = document.querySelector("shadow-box").attachShadow({mode:"open"}); r.innerHTML = "<button>Shadow go</button><a href=\\"mailto:s@example.com\\"><span>Shadow mail</span></a>";</script>';
  const server = await serve(url => url === '/inner' ? '<button>Frame go</button><a href="mailto:f@example.com"><span>Frame mail</span></a>' : `${body}<iframe src="/inner" width="400" height="150"></iframe>`);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    const controls = (await lookAt(page)).controls;
    const names = controls.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['Help center', 'Advanced', 'Shadow go', 'Frame go']));
    for (const gone of ['me@example.com', 'Call us', 'Shadow mail', 'Frame mail']) expect(names, gone).not.toContain(gone);
    expect(controls.find(c => c.name === 'Frame go')?.frame).toBe(true);
    expect(controls.find(c => c.name === 'Help center')?.href).toMatch(/\/help$/);
  } finally {
    await browser.close();
    server.close();
  }
}, 60_000);

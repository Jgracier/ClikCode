/** The page reader on a page the browser builds with JavaScript, then the classifier on it. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { classify, type PageRole } from './connector-qualify.js';
import { READ_PAGE } from './connector-qualify-live.js';

const SKIP = process.env.CLIKCODE_COMPUTER_SMOKE !== '1';
const pages: Record<string, string> = {
  '/signup': `<html><body><div id="app"></div><script>setTimeout(() => { document.getElementById('app').innerHTML = '<h1>Create account</h1><form><input type="email" placeholder="Email"><input type="password"><p>A credit card is required to start the trial.</p><div class="h-captcha" style="width:300px;height:80px"></div></form>'; }, 100)</script></body></html>`,
  '/free': `<html><body><div id="app"></div><script>setTimeout(() => { document.getElementById('app').innerHTML = '<h1>Join</h1><form><input type="email"><p>Free forever. No credit card required.</p></form><div class="grecaptcha-badge" style="width:256px;height:60px"><iframe src="about:blank" style="width:256px;height:60px"></iframe></div><small>This site is protected by reCAPTCHA</small>'; }, 100)</script></body></html>`,
  '/docs': `<html><body><script>document.body.innerHTML = '<p>The API is only available to Enterprise customers.</p>'</script></body></html>`,
};

it.skipIf(SKIP)('reads text, form and captcha widget from pages built by script, and classifies them', async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(pages[req.url ?? ''] ?? ''); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const read = async (path: string, role: PageRole) => {
      const page = await browser.newPage();
      await page.goto(base + path);
      await page.waitForTimeout(500);
      const got = await page.evaluate(READ_PAGE) as Record<string, unknown>;
      return { role, url: base + path, status: 200, ...got } as Parameters<typeof classify>[1][number];
    };
    const signup = await read('/signup', 'signup');
    expect(signup).toMatchObject({ hasForm: true, hasEmailField: true, captchaWidget: true });
    expect(classify('v', [signup]).kinds).toEqual(['captcha', 'card']);
    const free = await read('/free', 'signup');
    expect(free).toMatchObject({ hasForm: true, captchaWidget: false });
    expect(classify('v', [free]).kinds).toEqual([]);
    expect(classify('v', [await read('/docs', 'docs')]).kinds).toEqual(['paid-plan', 'enterprise']);
  } finally { await browser.close(); server.close(); }
}, 60_000);

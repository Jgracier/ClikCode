/** Which pages are held back from the agent, in real Chrome. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { privateLoginPage } from './private-page.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
let browser: Browser | undefined;
beforeAll(async () => { if (enabled) browser = await chromium.launch({ channel: 'chrome', headless: true }); }, 60_000);
afterAll(async () => { await browser?.close(); });

async function held(html: string, url = 'https://example.com/'): Promise<boolean> {
  const page = await browser!.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  return privateLoginPage(page);
}

it.skipIf(!enabled)('holds back a sign-in form', async () => {
  expect(await held('<label>Email<input type="text" autocomplete="username"></label><label>Password<input type="password"></label>')).toBe(true);
  expect(await held('<label>Password<input type="password"></label>')).toBe(true);
});

it.skipIf(!enabled)('holds back an auth URL even with no field', async () => {
  expect(await held('<p>Check your phone</p>', 'https://example.com/signin/challenge')).toBe(true);
});

it.skipIf(!enabled)('reads a page whose only password field is an account\'s key on display', async () => {
  expect(await held('<h1>API Access</h1><label>Current API Key<input type="password" value="x"></label><button>Change API Key</button>')).toBe(false);
});

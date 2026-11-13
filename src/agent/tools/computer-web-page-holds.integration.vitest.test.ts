/** capture_secret's guard against a placeholder from another page, against a real Chrome. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { pageHolds } from './computer-web.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
let browser: Browser | undefined;
beforeAll(async () => { if (enabled) browser = await chromium.launch({ channel: 'chrome', headless: true }); }, 60_000);
afterAll(async () => { await browser?.close(); });

it.skipIf(!enabled)('finds a value in the page text, a field, markup or a frame, and not one that belongs to another page', async () => {
  const page = await browser!.newPage();
  await page.setContent(`<p>Setup key: <code>JBSWY3DPEHPK3PXP</code></p><input value="sk_live_in_a_field"><div data-key="in-an-attribute-123"></div>
    <iframe srcdoc="<p>framed-secret-456</p>"></iframe>`);
  await page.waitForTimeout(300);
  expect(await pageHolds(page, 'JBSWY3DPEHPK3PXP')).toBe(true);
  expect(await pageHolds(page, 'sk_live_in_a_field')).toBe(true);
  expect(await pageHolds(page, 'in-an-attribute-123')).toBe(true);
  expect(await pageHolds(page, 'framed-secret-456')).toBe(true);
  expect(await pageHolds(page, 'A-SEED-FROM-ANOTHER-TAB')).toBe(false);
  await page.fill('input', 'typed-after-load-789');
  expect(await pageHolds(page, 'typed-after-load-789')).toBe(true);
}, 60_000);

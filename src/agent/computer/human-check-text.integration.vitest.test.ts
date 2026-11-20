/** Finding a "type the text in the image" captcha in real Chrome. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TEXT_CAPTCHA } from './human-check-inpage.js';

const SMOKE = process.env.CLIKCODE_COMPUTER_SMOKE !== '1';
const PICTURE = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="20" y="40" font-size="30">x7Kp2</text></svg>');
let browser: Browser;
beforeAll(async () => { if (!SMOKE) browser = await chromium.launch({ channel: 'chrome', headless: true }); });
afterAll(async () => { await browser?.close(); });

it.skipIf(SMOKE)('finds the field when its instruction is block text beside honeypot boxes, not a label (FeedBlitz sign-up)', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form><table><tr><td>Account login email: <input type="text" name="email" id="email"></td></tr>
    <tr><td><div class="form-group">To help stop spam, please type the text here that you see in the image below.
      <input type="email" name="email_" style="width:0;height:0;border:0;padding:0">
      <input type="email" name="_email" style="width:0;height:0;border:0;padding:0"><br>
      <input type="text" name="VERIFY" id="VERIFY"><br><img src="${PICTURE}" width="200" height="60"></div></td></tr></table></form>`);
  expect(await page.evaluate(TEXT_CAPTCHA)).toEqual({ filled: false });
  expect(await page.getAttribute('[data-clikcode-captcha-field="1"]', 'name')).toBe('VERIFY');
  await page.close();
}, 30_000);

it.skipIf(SMOKE)('leaves a one-time code field sent by text message alone, even beside a picture', async () => {
  const page = await browser.newPage();
  await page.setContent(`<div><img src="${PICTURE}" width="200" height="60"><p>Enter the verification code we sent to your phone.</p>
    <div><input type="text" name="otp"></div></div>`);
  expect(await page.evaluate(TEXT_CAPTCHA)).toBeNull();
  await page.close();
}, 30_000);

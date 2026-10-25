/** A key shown in an ordinary text box is hidden in every view, in real Chrome. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { observeComputerPage } from '../tools/computer-web.js';

const SMOKE = process.env.CLIKCODE_COMPUTER_SMOKE !== '1';
// Built from parts so no key-shaped text sits in the source.
const SHORT = ['k3y', '9x2Qa7', 'LmN4'].join('');
const PLAIN = ['wordhosting', 'account', 'secretvalue'].join('');

it.skipIf(SMOKE)('hides a key shown in a plain, read-only or labelled text box on an account page', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  try {
    const page = await browser.newPage();
    await page.setContent(`<h1>Account</h1>
      <label>Your API key <input type="text" value="${SHORT}"></label>
      <label>Token <input readonly value="${PLAIN}"></label>
      <div>Secret</div><textarea>${PLAIN}2</textarea>
      <label>Display name <input value="Justin Gracier"></label>`);
    const result = await observeComputerPage(page, false);
    expect(result.output).not.toContain(SHORT);
    expect(result.output).not.toContain(PLAIN);
    expect(result.output).toContain('Justin Gracier');
    const found = await observeComputerPage(page, false, false, 'API key');
    expect(found.output).not.toContain(SHORT);
  } finally {
    await browser.close();
  }
}, 40_000);

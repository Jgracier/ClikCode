/** A sign-up password box inside a frame gets a password that meets the rules written beside it in that frame (Braintree's
 * activation form). In real Chrome; opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';

it.skipIf(!enabled)('reads the password rules in the frame that holds the box', async () => {
  const { askForFills, observeComputerPage } = await import('./computer-web.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-frame-password-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  try {
    const page = await browser.newPage();
    const form = '<h2>Create your password</h2><label>Password <input type="password" name="user[password]" minlength="30" aria-describedby="rule"></label><p id="rule">Must be at least 30 characters.</p><label>Confirm password <input type="password" name="user[password_confirmation]"></label><button>Activate</button>';
    await page.route('https://signup.example/**', route => route.fulfill({ contentType: 'text/html', body: route.request().url().endsWith('/form') ? form : '<h1>Activate your sandbox</h1><iframe src="/form" width="600" height="400"></iframe>' }));
    await page.goto('https://signup.example/activate');
    await page.frameLocator('iframe').locator('input[type=password]').first().waitFor();
    const view = (await observeComputerPage(page, false)).output;
    const ref = /textbox "Password" \[ref=(f\d+e\d+)\]/.exec(view)?.[1];
    expect(ref).toBeDefined();
    const steps = await askForFills(page, [{ do: 'fill' as const, target: ref! }], { stateDir, signal: undefined } as never);
    expect(steps[0]!.text!.length).toBeGreaterThanOrEqual(30);
  } finally {
    await browser.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);

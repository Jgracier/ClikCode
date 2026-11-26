import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialInspectionUnavailable, credentialOnScreen, sensitiveValues } from './sensitive-fields.js';

describe.skipIf(process.env['CLIKCODE_COMPUTER_SMOKE'] !== '1')('desktop credential visibility in Chrome', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => { await browser?.close(); });
  const check = () => credentialOnScreen('/unused', undefined, { listPages: async () => [page] });

  it('ignores hidden, transparent and offscreen retained fields while preserving text scrubbing', async () => {
    await page.setContent(`<h1>Account profile</h1>
      <input type="password" value="synthetic-password" hidden>
      <div style="display:none"><input autocomplete="one-time-code" value="123456"></div>
      <input autocomplete="cc-number" value="4242424242424242" style="opacity:0">
      <input autocomplete="one-time-code" value="synthetic-offscreen" style="position:absolute;top:20000px">`);
    expect(await check()).toBe(false);
    expect(await sensitiveValues(page)).toContain('synthetic-password');
  });
  it('allows masked passwords, blocks a revealed one, and allows it after clearing', async () => {
    await page.setContent('<input type="password" autocomplete="current-password" value="synthetic-password">');
    expect(await check()).toBe(false);
    expect(await sensitiveValues(page)).toContain('synthetic-password');
    await page.locator('input').evaluate(node => { (node as HTMLInputElement).type = 'text'; });
    expect(await check()).toBe(true);
    await page.locator('input').fill('');
    expect(await check()).toBe(false);
  });
  it('checks hosted fields but ignores a hidden frame', async () => {
    await page.setContent(`<iframe srcdoc='<input autocomplete="cc-number" value="4242424242424242">'></iframe>`);
    await page.frameLocator('iframe').locator('input').waitFor();
    expect(await check()).toBe(true);
    for (const style of ['display:none', 'opacity:0', 'position:absolute;top:20000px']) {
      await page.locator('iframe').evaluate((node, style) => node.setAttribute('style', style), style);
      expect(await check()).toBe(false);
    }
  });
  it('reports an inspection error separately from credential detection', async () => {
    await expect(credentialOnScreen('/unused', undefined, { listPages: async () => { throw new Error('connection refused'); } })).rejects.toBeInstanceOf(CredentialInspectionUnavailable);
  });
});

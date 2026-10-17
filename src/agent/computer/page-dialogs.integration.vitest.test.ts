/** A page's confirm() box, in real Chrome: reported and declined by default, accepted on request. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dialogNote, withDialogs } from './page-dialogs.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
let browser: Browser | undefined;
beforeAll(async () => { if (enabled) browser = await chromium.launch({ channel: 'chrome', headless: true }); }, 60_000);
afterAll(async () => { await browser?.close(); });

const html = `<button id="d" onclick="document.title = confirm('Delete this token?') ? 'deleted' : 'kept'">Delete</button>`;

it.skipIf(!enabled)('declines a confirm by default and says what was asked', async () => {
  const page = await browser!.newPage();
  await page.setContent(html);
  const { dialogs } = await withDialogs(page, false, () => page.click('#d'));
  expect(await page.title()).toBe('kept');
  expect(dialogs).toEqual(['confirm: "Delete this token?" (declined)']);
  expect(dialogNote(dialogs, false)).toContain('click again with accept_dialog true');
}, 30_000);

it.skipIf(!enabled)('accepts the confirm when asked to', async () => {
  const page = await browser!.newPage();
  await page.setContent(html);
  const { dialogs } = await withDialogs(page, true, () => page.click('#d'));
  expect(await page.title()).toBe('deleted');
  expect(dialogs).toEqual(['confirm: "Delete this token?" (accepted)']);
}, 30_000);

it('reports nothing when no dialog appeared', () => {
  expect(dialogNote([], false)).toBe('');
});

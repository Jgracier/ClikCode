/** The per-fill deadline races the whole fill: a page script that never returns cannot hold the tool. Local fixture page, no network. */
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fillWhole } from './computer-web.js';

let browser: Browser | undefined;
beforeAll(async () => {
  try { browser = await chromium.launch({ headless: true }); } catch { try { browser = await chromium.launch({ channel: 'chrome', headless: true }); } catch { browser = undefined; } }
}, 60_000);
afterAll(async () => { await browser?.close(); });

it('a fill whose page evaluate never returns gives up with the field label, reloads the tab and describes the page', async ctx => {
  if (!browser) return ctx.skip();
  const page = await (await browser.newContext()).newPage();
  await page.route('https://vendor.example/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Registro</h1><label>Contraseña <input type="password"></label>' }));
  await page.goto('https://vendor.example/registro');
  await page.evaluate(() => { (globalThis as unknown as { stale: number }).stale = 1; });
  const started = Date.now();
  const result = await fillWhole(page, { action: 'fill', target: 'Contraseña' } as never, { stateDir: '/nonexistent' } as never,
    async clock => { clock.field = 'Contraseña'; await page.evaluate(() => new Promise(() => undefined)); return { output: 'never' }; }, 400);
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(result.isError).toBe(true);
  expect(result.output).toContain('fill did not finish: Contraseña');
  expect(result.output).toContain('Registro');
  // The reload ran: the page's own state from before is gone.
  expect(await page.evaluate(() => (globalThis as unknown as { stale?: number }).stale)).toBeUndefined();
  await page.close();
}, 40_000);

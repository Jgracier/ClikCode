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

it('unattended password fill uses the complete saved login without asking for confirmation', async ctx => {
  if (!browser) return ctx.skip();
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { saveLoginFields, lockCredentialVault } = await import('../computer/credential-vault.js');
  const { setUnattended } = await import('../computer/settings.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'autofill-regression-'));
  const context = await browser!.newContext();
  try {
    await setUnattended(stateDir, true);
    await saveLoginFields(stateDir, 'https://vendor.example', { username: 'ready@example.com', password: 'fixture-only-secret' });
    await saveLoginFields(stateDir, 'https://vendor.example', { username: 'incomplete@example.com' });
    const page = await context.newPage();
    await page.route('https://vendor.example/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Sign in</h1><label>Password<input type="password" autocomplete="current-password"></label>' }));
    await page.goto('https://vendor.example/login');
    let prompts = 0;
    const result = await fillWhole(page, { action: 'fill', target: 'Password' } as never, { stateDir, requestPrivateLogin: async () => { prompts++; throw new Error('Unexpected prompt'); } } as never);
    expect(result.isError).not.toBe(true);
    expect(prompts).toBe(0);
    expect(await page.locator('input').inputValue()).toBe('fixture-only-secret');
    expect(result.output).not.toContain('fixture-only-secret');
  } finally {
    await context.close();
    lockCredentialVault(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 40_000);

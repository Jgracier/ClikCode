/** Opt-in live test of the private login page, Tailcat and local encrypted vault. */
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { requestTailcatCredential } from './tailcat-credentials.js';

it.skipIf(process.env.CLIKCODE_TAILCAT_E2E !== '1')('saves a login without exposing it in the link or result', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-login-e2e-'));
  const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/handoff');
  const server = createServer(async (request, response) => {
    const name = path.basename(new URL(request.url ?? '/', 'http://localhost').pathname);
    try {
      const bytes = await fs.readFile(path.join(folder, name === 'handoff' ? 'index.html' : name));
      response.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.gz') ? 'application/gzip' : 'text/html');
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    let link!: string;
    let ready!: () => void;
    const linkReady = new Promise<void>(resolve => { ready = resolve; });
    const request = requestTailcatCredential({ stateDir, site: 'https://accounts.example.test',
      pageUrl: process.env.CLIKCODE_TAILCAT_PAGE_URL ?? `http://127.0.0.1:${(server.address() as { port: number }).port}/handoff/`,
      onLink: url => { link = url; ready(); } });
    await linkReady;
    expect(link).not.toContain('private@example.test');
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(link);
    await expect.poll(() => page.locator('#credential').isVisible(), { timeout: 45_000 }).toBe(true);
    await page.locator('#email').fill('private@example.test');
    await page.locator('#password').fill('synthetic-secret-123');
    await page.getByRole('button', { name: 'Save login' }).click();
    await expect.poll(() => page.locator('#status').textContent(), { timeout: 10_000 }).toContain('Login saved');
    const id = await request;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(errors).toEqual([]);
    const encrypted = await fs.readFile(path.join(stateDir, 'computer', 'vault', 'items', `${id}.json`), 'utf8');
    expect(encrypted).not.toContain('private@example.test');
    expect(encrypted).not.toContain('synthetic-secret-123');
  } finally { await browser.close(); server.close(); await fs.rm(stateDir, { recursive: true, force: true }); }
}, 120_000);

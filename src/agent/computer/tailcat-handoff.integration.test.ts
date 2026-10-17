/** Opt-in live transport check: CLI Tailcat, browser WASM, image and tap protocol. */
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({ screenshot: Buffer.alloc(0), clicks: [] as [number, number][] }));
vi.mock('./browser.js', () => ({ computerPage: async () => ({
  screenshot: async () => testState.screenshot,
  mouse: { click: async (x: number, y: number) => { testState.clicks.push([x, y]); }, wheel: async () => undefined },
  keyboard: { insertText: async () => undefined, press: async () => undefined },
}) }));
vi.mock('./tailcat-binary.js', () => ({ tailcatBinary: async () => process.env.CLIKCODE_TAILCAT_BINARY }));
import { runTailcatHandoff } from './tailcat-handoff.js';

it.skipIf(!process.env.CLIKCODE_TAILCAT_BINARY)('connects the phone page, shows the browser, handles a tap and Done', async () => {
  const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/handoff');
  const server = createServer(async (request, response) => {
    const name = path.basename(new URL(request.url ?? '/', 'http://localhost').pathname);
    const file = path.join(folder, name === 'handoff' ? 'index.html' : name);
    try {
      const bytes = await fs.readFile(file);
      response.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.gz') ? 'application/gzip' : 'text/html');
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const source = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await source.setContent('<h1>ClikCode handoff smoke</h1>');
    testState.screenshot = await source.screenshot({ type: 'jpeg' });
    testState.clicks.length = 0;
    let link!: string;
    let linkReady!: () => void;
    const ready = new Promise<void>(resolve => { linkReady = resolve; });
    const handoff = runTailcatHandoff({ stateDir: '/tmp/unused-tailcat-smoke', pageUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/handoff/`, onLink: url => { link = url; linkReady(); } });
    await ready;
    const phone = await browser.newPage({ viewport: { width: 400, height: 800 } });
    const errors: string[] = [];
    phone.on('pageerror', error => errors.push(error.message));
    await phone.goto(link);
    await expect.poll(async () => phone.locator('#screen').isVisible(), { timeout: 45_000 }).toBe(true);
    await phone.locator('#screen').click({ position: { x: 100, y: 100 } });
    await expect.poll(() => testState.clicks.length, { timeout: 10_000 }).toBe(1);
    await phone.locator('#done').click();
    await handoff;
    expect(testState.clicks[0][0]).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.close(); }
}, 120_000);

/** show against a real Chrome: a desktop browser (a second, headless Chrome standing in for the user's) watches the chat's tab while the
 * "agent" keeps acting on it. The window is smaller than the tab, so the picture is scaled and a click has to be mapped back.
 * Opt in with CLIKCODE_COMPUTER_SMOKE=1 (and CLIKCODE_BROWSER_HOST_ENTRY=<built dist/index.js> from a source checkout). Nothing is opened
 * on the real desktop: the opener is a recorder. */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { expect, it } from 'vitest';
import { closeComputerBrowser, openComputerPage, openNewComputerPage, throwawayComputerPage } from './browser.js';
import { showTab } from './handoff-show.js';

const wait = async <T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = 8_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (ok(value) || Date.now() > end) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
};

const PAGE = (name: string): string => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><body style="margin:0;font:16px sans-serif">
<button id="b" style="position:absolute;left:600px;top:400px;width:200px;height:80px" onclick="document.title='${name} clicked'">Press</button>
<input id="name" aria-label="Full name" style="position:absolute;left:100px;top:100px;width:300px;height:40px">
<div id="n"></div><script>setInterval(()=>{document.getElementById('n').textContent=String(Date.now()%100000)},40);addEventListener('keydown',e=>{if(e.target===document.body)document.body.dataset.key=e.key})</script>`;

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('shows the tab in a desktop browser while the agent works: scaled picture, clicks that land, the same address again, the next tab, and an end', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-show-'));
  const site = createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end(PAGE(request.url === '/two' ? 'two' : 'one')); });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const opened: string[] = [];
  const deps = { open: async (url: string) => { opened.push(url); return true; }, session: () => ({}), remote: () => false, hostDisplay: async () => 'hidden' as const };
  let userBrowser: Browser | undefined;
  try {
    const page = await openComputerPage(stateDir);
    await page.goto(`${base}/one`);
    const sizeBefore = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, touch: navigator.maxTouchPoints }));

    const first = await showTab({ stateDir }, deps);
    expect(first).toMatch(/^Opened a live view/);
    expect(opened).toHaveLength(1);
    const address = opened[0]!;
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{32}\/$/);
    expect(first).toContain(address);

    userBrowser = await chromium.launch({ channel: 'chrome', headless: true });
    const view = await (await userBrowser.newContext({ viewport: { width: 760, height: 560 } })).newPage();
    await view.goto(address);
    const live = <T>(code: string): Promise<T> => view.evaluate(`(${code})(window.__handoff)`) as Promise<T>;
    expect(await wait(() => live<number>('h => h.frames'), frames => frames >= 2)).toBeGreaterThanOrEqual(2);
    expect(await view.locator('#done').count()).toBe(0);
    expect(await live<string>('h => h.mode')).toBe('mouse');

    // The tab is as the agent had it: not resized to the window, no touch screen.
    expect(await page.evaluate(() => ({ w: innerWidth, h: innerHeight, touch: navigator.maxTouchPoints }))).toEqual(sizeBefore);
    const scale = await wait(() => live<number>('h => h.scale || 0'), value => value > 0);
    expect(scale).toBeGreaterThan(0);
    if (sizeBefore.w > 760) expect(scale).toBeLessThan(1);
    const picture = await view.evaluate(() => { const r = document.getElementById('c')!.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
    expect(Math.abs(picture.width - sizeBefore.w * scale)).toBeLessThan(2);
    expect(picture.left + picture.width).toBeLessThanOrEqual(761);
    expect(picture.top + picture.height).toBeLessThanOrEqual(561);
    const onScreen = (x: number, y: number): [number, number] => [picture.left + x * scale, picture.top + y * scale];

    // A click in the scaled picture lands on the button in the page.
    await view.mouse.click(...onScreen(700, 440));
    expect(await wait(() => page.title(), title => title === 'one clicked')).toBe('one clicked');

    // The agent keeps working in the same tab, and the viewer sees its field change.
    await page.locator('#name').fill('typed by the agent');
    const over = view.locator('#overlays > input').first();
    expect(await wait(() => over.inputValue().catch(() => ''), value => value === 'typed by the agent')).toBe('typed by the agent');
    // The user types in the field through the view, and a key at the picture itself reaches the page.
    await view.mouse.click(...onScreen(250, 120));
    await view.keyboard.press('Control+a');
    await view.keyboard.type('by the user');
    expect(await wait(() => page.locator('#name').inputValue(), value => value === 'by the user')).toBe('by the user');
    await view.mouse.click(...onScreen(900, 700));
    await view.keyboard.press('k');
    expect(await wait(() => page.evaluate(() => document.body.dataset['key'] ?? ''), key => key === 'k')).toBe('k');

    // Asked again while it is being watched: the same address, and no second window.
    const again = await showTab({ stateDir }, deps);
    expect(again).toContain(address);
    expect(again).toContain('already has the live view');
    expect(opened).toHaveLength(1);

    // Another chat's tab comes to the front of the shared browser: this one is still painted for whoever is watching it.
    const other = await throwawayComputerPage(stateDir);
    await other.goto(`${base}/two`);
    await other.bringToFront();
    const behind = await live<number>('h => h.frames');
    expect(await wait(() => live<number>('h => h.frames'), frames => frames > behind + 5)).toBeGreaterThan(behind + 5);
    await view.mouse.click(...onScreen(700, 440));
    expect(await other.title()).toBe('two');
    await other.close();

    // The chat moves to another tab: the view follows it by itself.
    const second = await openNewComputerPage(stateDir);
    await second.goto(`${base}/two`);
    const framesBefore = await live<number>('h => h.frames');
    await wait(() => live<number>('h => h.frames'), frames => frames > framesBefore + 2, 10_000);
    await wait(async () => { await view.mouse.click(...onScreen(700, 440)); return second.title(); }, title => title === 'two clicked', 10_000);
    expect(await second.title()).toBe('two clicked');
    expect(await page.title()).toBe('one clicked');

    // Cleared: the address is gone and the page says so; the tab is still as it was.
    expect(await showTab({ stateDir, clear: true }, deps)).toBe('The live view is closed. The tab is unchanged.');
    expect(await fetch(address).then(response => response.status, () => 0)).not.toBe(200);
    expect(await second.evaluate(() => ({ w: innerWidth, h: innerHeight, touch: navigator.maxTouchPoints }))).toEqual(sizeBefore);
  } finally {
    await showTab({ stateDir, clear: true }, deps).catch(() => undefined);
    await userBrowser?.close().catch(() => undefined);
    await closeComputerBrowser(stateDir).catch(() => undefined);
    site.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120_000);

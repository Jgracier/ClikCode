/** The phone link as an agent gets it: the `handoff` action of browser_use, twice, with a phone-shaped Chrome on the link. The page
 * holds what a CAPTCHA does: a press-and-hold button, an image grid and a field, all inside a frame from another site.
 * Opt in with CLIKCODE_COMPUTER_SMOKE=1 (and CLIKCODE_BROWSER_HOST_ENTRY=<built dist/index.js> from a source checkout). */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { expect, it } from 'vitest';
import { closeComputerBrowser, openComputerPage } from './browser.js';
import { tailnetAddress } from './tailnet-handoff.js';
import { browserUseTool } from '../tools/computer-web.js';

const wait = async <T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = 6_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (ok(value) || Date.now() > end) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
};

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1' || !tailnetAddress())('hands a CAPTCHA-shaped page to a phone through the tool: tiles, press and hold, a field in the frame', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-handoff-tool-'));
  const inner = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;font:16px sans-serif">
<div id="grid" style="display:grid;grid-template-columns:repeat(3,90px);gap:6px;margin:10px"></div>
<button id="hold" style="margin:10px;width:200px;height:70px">Press and hold</button>
<input id="answer" aria-label="Type the letters" style="margin:10px;width:200px;height:44px;font-size:16px">
<script>
const picked = new Set(); const grid = document.getElementById('grid');
for (let i = 0; i < 9; i++) { const t = document.createElement('div'); t.style.cssText = 'height:90px;background:#9ab'; t.onclick = () => { picked.has(i) ? picked.delete(i) : picked.add(i); t.style.background = picked.has(i) ? '#2a6' : '#9ab'; parent.postMessage('tiles ' + [...picked].sort().join(','), '*'); }; grid.appendChild(t); }
const hold = document.getElementById('hold'); let down = 0;
const press = () => { down = performance.now(); }; const release = () => { if (down) parent.postMessage('held ' + (performance.now() - down > 800 ? 'long' : 'short'), '*'); down = 0; };
hold.addEventListener('mousedown', press); hold.addEventListener('mouseup', release); hold.addEventListener('touchstart', press); hold.addEventListener('touchend', release);
document.getElementById('answer').addEventListener('input', e => parent.postMessage('typed ' + e.target.value, '*'));
</script>`);
  });
  await new Promise<void>(resolve => inner.listen(0, '127.0.0.1', resolve));
  const outer = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>start</title><body style="margin:0"><iframe src="http://localhost:${(inner.address() as AddressInfo).port}/" style="position:absolute;left:10px;top:20px;width:320px;height:520px;border:0"></iframe><script>addEventListener('message', e => { document.title = String(e.data); });</script>`);
  });
  await new Promise<void>(resolve => outer.listen(0, '127.0.0.1', resolve));
  let phoneBrowser: Browser | undefined;
  try {
    const page = await openComputerPage(stateDir);
    await page.goto(`http://127.0.0.1:${(outer.address() as AddressInfo).port}/`);
    const ctx = { stateDir } as never;
    const first = await browserUseTool.run({ action: 'handoff' } as never, ctx);
    expect(first.isError).not.toBe(true);
    const link = /http:\/\/\S+\/[\w-]{32}\//.exec(first.output)?.[0] ?? '';
    expect(link).not.toBe('');
    const waiting = browserUseTool.run({ action: 'handoff' } as never, ctx);

    phoneBrowser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await phoneBrowser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const phone = await context.newPage();
    await phone.goto(link);
    const frames = (): Promise<number> => phone.evaluate(() => (window as unknown as { __handoff: { frames: number } }).__handoff.frames);
    expect(await wait(frames, count => count >= 1)).toBeGreaterThanOrEqual(1);
    const stage = await phone.evaluate(() => { const r = document.getElementById('c')!.getBoundingClientRect(); return { left: r.left, top: r.top }; });
    const frameOf = page.frames().find(frame => frame !== page.mainFrame())!;
    const settled = async (selector: string) => {
      let last = '', same = 0;
      for (let i = 0; i < 60 && same < 3; i++) { const now = JSON.stringify(await frameOf.locator(selector).boundingBox()); same = now === last ? same + 1 : 0; last = now; await new Promise(resolve => setTimeout(resolve, 60)); }
      const box = (await frameOf.locator(selector).boundingBox())!;
      const frameBox = (await page.locator('iframe').boundingBox())!;
      return { x: stage.left + frameBox.x + (box.x - frameBox.x) + box.width / 2, y: stage.top + box.y + box.height / 2 };
    };
    const results: Record<string, string> = {};

    // Image tiles: two taps pick two tiles, a third unpicks one.
    const tile = async (n: number) => { const box = (await frameOf.locator('#grid > div').nth(n).boundingBox())!; const frameBox = (await page.locator('iframe').boundingBox())!; await phone.touchscreen.tap(stage.left + frameBox.x + (box.x - frameBox.x) + box.width / 2, stage.top + box.y + box.height / 2); };
    await tile(1); await tile(4); await tile(1);
    results['tiles'] = await wait(() => page.title(), title => title === 'tiles 4', 4_000);

    // Press and hold, as a finger does: down, a second, up.
    const hold = await settled('#hold');
    const cdp = await context.newCDPSession(phone);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: hold.x, y: hold.y }] });
    await new Promise(resolve => setTimeout(resolve, 1200));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    results['hold'] = await wait(() => page.title(), title => title.startsWith('held'), 4_000);

    // A field in the frame: tap it, type with the phone's keyboard.
    const answer = await settled('#answer');
    await phone.touchscreen.tap(answer.x, answer.y);
    await new Promise(resolve => setTimeout(resolve, 400));
    await phone.keyboard.type('xk7');
    results['typed'] = await wait(() => page.title(), title => title === 'typed xk7', 4_000);
    console.log(`handoff-tool results: ${JSON.stringify(results)}`);

    expect(results['tiles']).toBe('tiles 4');
    expect(results['hold']).toBe('held long');
    expect(results['typed']).toBe('typed xk7');

    await phone.locator('#done').click();
    const outcome = await waiting;
    expect(outcome.isError).not.toBe(true);
    expect(outcome.output).toContain('finished');
  } finally {
    await phoneBrowser?.close().catch(() => undefined);
    await closeComputerBrowser(stateDir).catch(() => undefined);
    inner.close(); outer.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90_000);

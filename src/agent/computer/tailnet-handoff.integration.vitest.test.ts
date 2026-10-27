/** The phone link in real Chrome: ClikCode's tab on one side, a phone-shaped Chrome (touch, 3x density) opening the link on the other.
 * Opt in with CLIKCODE_COMPUTER_SMOKE=1 (and CLIKCODE_BROWSER_HOST_ENTRY=<built dist/index.js> from a source checkout). */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { expect, it } from 'vitest';
import { closeComputerBrowser, openComputerPage } from './browser.js';
import { runTailnetHandoff, tailnetAddress } from './tailnet-handoff.js';

it('finds the Tailscale address among the interfaces, and none without one', () => {
  const entry = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '', mac: '', cidr: null });
  expect(tailnetAddress({ lo: [entry('127.0.0.1', true)], eth0: [entry('192.168.1.5')], tailscale0: [entry('100.70.212.126')] })).toBe('100.70.212.126');
  expect(tailnetAddress({ eth0: [entry('100.20.1.1'), entry('10.0.0.2')] })).toBeUndefined();
});

const SITE = `<title>t0</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:16px sans-serif}input,select,button{display:block;margin:14px 20px;width:300px;height:44px;font-size:16px}#n{font-size:40px;margin:0 20px}</style>
<button id="b" onclick="document.title='clicked'">Tap me</button>
<input id="name" aria-label="Full name"><input id="pw" type="password" autocomplete="current-password" aria-label="Password">
<input id="otp" autocomplete="one-time-code" inputmode="numeric" aria-label="Code">
<select id="sel" aria-label="Plan" onchange="document.title='plan '+this.value"><option value="a">Free</option><option value="b">Pro</option></select>
<input id="when" type="date" aria-label="Start date" onchange="document.title='date '+this.value">
<div id="n"></div><div style="height:3000px"></div>
<script>setInterval(()=>{document.getElementById('n').textContent=String(Date.now()%100000)},40)</script>`;

const wait = async <T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = 6_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (ok(value) || Date.now() > end) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
};

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('shows the tab live on a phone, takes touch and the phone\'s own keyboard, and ends when the user is done', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-tailnet-'));
  const site = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(SITE); });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  let phoneBrowser: Browser | undefined;
  try {
    const page = await openComputerPage(stateDir);
    await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`);
    const widthBefore = await page.evaluate(() => innerWidth);
    const touchBefore = await page.evaluate(() => navigator.maxTouchPoints);

    let link = '';
    const run = runTailnetHandoff({ stateDir, host: '127.0.0.1', onLink: value => { link = value; } });
    for (let i = 0; i < 50 && !link; i++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{32}\/$/);

    // The wrong secret, a foreign origin and a page that is not the socket's are all refused.
    expect((await fetch(link.replace(/\/[\w-]{32}\/$/, '/wrongwrongwrongwrongwrongwrongwr/'))).status).toBe(404);
    const html = await fetch(link);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
    const foreign = await new Promise<string>(resolve => {
      const url = new URL(`${link}live`);
      const req = httpRequest(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'http://evil.example' } });
      req.on('upgrade', () => resolve('upgraded')); req.on('response', res => resolve(`status ${res.statusCode}`)); req.on('error', () => resolve('closed')); req.end();
    });
    expect(foreign).not.toBe('upgraded');

    phoneBrowser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await phoneBrowser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const phone = await context.newPage();
    const notes: string[] = [];
    phone.on('console', message => notes.push(`console: ${message.text()}`));
    phone.on('pageerror', error => notes.push(`pageerror: ${String(error)}`));
    phone.on('websocket', socket => { notes.push(`websocket ${socket.url()}`); socket.on('close', () => notes.push('websocket closed')); });
    await phone.goto(link);
    const handoff = <T,>(read: string): Promise<T> => phone.evaluate(`(${read})(window.__handoff)`) as Promise<T>;

    // Frames arrive and keep arriving as the page changes, drawn on the canvas.
    const first = await wait(() => handoff<number>('h => h.frames'), frames => frames > 5);
    if (first <= 5) console.log(`no frames; phone page said: ${JSON.stringify(notes)} state ${JSON.stringify(await phone.evaluate(() => (window as unknown as { __handoff: unknown }).__handoff))}`);
    expect(first).toBeGreaterThan(5);
    const before = await handoff<number>('h => h.frames');
    expect(await wait(() => handoff<number>('h => h.frames'), frames => frames > before + 5)).toBeGreaterThan(before + 5);
    expect(await phone.evaluate(() => { const c = document.getElementById('c') as HTMLCanvasElement; const d = c.getContext('2d')!.getImageData(0, 0, c.width, 40).data; return d.some(value => value > 0); })).toBe(true);

    // The page is laid out for the phone's own area, not shrunk to fit.
    const stage = await phone.evaluate(() => { const s = document.getElementById('stage')!; const r = document.getElementById('c')!.getBoundingClientRect(); return { w: s.clientWidth, h: s.clientHeight, left: r.left, top: r.top }; });
    expect(await wait(() => page.evaluate(() => innerWidth), width => width === stage.w)).toBe(stage.w);
    expect(await page.evaluate(() => ({ touch: navigator.maxTouchPoints, dpr: devicePixelRatio }))).toEqual({ touch: 5, dpr: 3 });

    const tap = async (selector: string): Promise<void> => {
      const box = (await page.locator(selector).boundingBox())!;
      await phone.touchscreen.tap(stage.left + box.x + box.width / 2, stage.top + box.y + box.height / 2);
    };

    // A tap is a real tap, and the picture of it is back quickly.
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => { document.title = 'reset'; });
      await tap('#b');
      const landed = await wait(() => page.title(), title => title === 'clicked');
      if (landed !== 'clicked') console.log(`tap ${i} did not land: ${JSON.stringify({ stage, box: await page.locator('#b').boundingBox(), page: await page.evaluate(() => ({ w: innerWidth, h: innerHeight, vv: [visualViewport!.width, visualViewport!.height, visualViewport!.scale], sx: scrollX, sy: scrollY })), notes })}`);
      expect(landed).toBe('clicked');
      await wait(() => handoff<number>('h => h.latency'), latency => latency > 0);
      latencies.push(await handoff<number>('h => h.latency'));
    }
    latencies.sort((a, b) => a - b);
    console.log(`phone link: tap to picture ${latencies.join(', ')} ms (median ${latencies[2]} ms, same machine)`);
    expect(latencies[2]).toBeLessThan(500);

    // Text: the phone's own box, of the page field's kind, and what is typed in it reaches the page.
    await tap('#name');
    await wait(() => handoff<string | null>('h => h.focus && h.focus.kind'), kind => kind === 'text');
    expect(await phone.locator('#proxy').getAttribute('type')).toBe('text');
    await phone.keyboard.type('hello');
    expect(await wait(() => page.locator('#name').inputValue(), value => value === 'hello')).toBe('hello');
    await phone.keyboard.press('Backspace'); await phone.keyboard.press('Backspace');
    expect(await wait(() => page.locator('#name').inputValue(), value => value === 'hel')).toBe('hel');
    await phone.locator('#proxy').fill('replaced by autofill');
    expect(await wait(() => page.locator('#name').inputValue(), value => value === 'replaced by autofill')).toBe('replaced by autofill');

    await tap('#pw');
    await wait(() => handoff<string | null>('h => h.focus && h.focus.type'), type => type === 'password');
    expect(await phone.locator('#proxy').getAttribute('type')).toBe('password');
    expect(await phone.locator('#proxy').getAttribute('autocomplete')).toBe('current-password');
    await phone.keyboard.type('s3cret');
    expect(await wait(() => page.locator('#pw').inputValue(), value => value === 's3cret')).toBe('s3cret');

    await tap('#otp');
    await wait(() => handoff<string | null>('h => h.focus && h.focus.autocomplete'), value => value === 'one-time-code');
    expect(await phone.locator('#proxy').getAttribute('autocomplete')).toBe('one-time-code');
    expect(await phone.locator('#proxy').getAttribute('inputmode')).toBe('numeric');

    // A choice and a date use the phone's own pickers, not a picture of the desktop's.
    await tap('#sel');
    await wait(() => handoff<string | null>('h => h.focus && h.focus.kind'), kind => kind === 'select');
    expect(await phone.locator('#proxy option').allInnerTexts()).toEqual(['Free', 'Pro']);
    await phone.locator('#proxy').selectOption('b');
    expect(await wait(() => page.title(), title => title === 'plan b')).toBe('plan b');
    await page.keyboard.press('Escape').catch(() => undefined);

    await tap('#when');
    await wait(() => handoff<string | null>('h => h.focus && h.focus.kind'), kind => kind === 'native');
    await phone.locator('#proxy').fill('2026-10-27');
    expect(await wait(() => page.title(), title => title === 'date 2026-10-27')).toBe('date 2026-10-27');

    // Scrolling by dragging a finger, and with a wheel.
    await page.evaluate(() => window.scrollTo(0, 0));
    const cdp = await context.newCDPSession(phone);
    const finger = async (type: string, y: number): Promise<void> => { await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: stage.left + 200, y: stage.top + y, id: 1 }] } as never); };
    await finger('touchStart', 500);
    for (let y = 480; y >= 200; y -= 20) { await finger('touchMove', y); await new Promise(resolve => setTimeout(resolve, 12)); }
    await finger('touchEnd', 200);
    expect(await wait(() => page.evaluate(() => scrollY), y => y > 150)).toBeGreaterThan(150);
    // A flick keeps gliding after the finger lifts: measure once it has stopped.
    let scrolled = -1;
    for (let still = 0; still < 5;) { const now = await page.evaluate(() => scrollY); still = now === scrolled ? still + 1 : 0; scrolled = now; await new Promise(resolve => setTimeout(resolve, 60)); }
    await phone.mouse.move(stage.left + 100, stage.top + 300);
    await phone.mouse.wheel(0, 300);
    // A wheel of 300 reaches the phone's page as 100 CSS pixels (3x density); the mobile layout may glide further.
    expect(await wait(() => page.evaluate(() => scrollY), y => y > scrolled + 50)).toBeGreaterThan(scrolled + 50);

    // The phone turning sideways re-lays the page out.
    await phone.setViewportSize({ width: 700, height: 390 });
    expect(await wait(() => page.evaluate(() => innerWidth), width => width > 600)).toBeGreaterThan(600);

    // Done ends it, puts the tab back as it was, and the link stops working.
    await phone.locator('#done').click();
    await run;
    expect(await wait(() => page.evaluate(() => innerWidth), width => width === widthBefore)).toBe(widthBefore);
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBe(touchBefore);
    await expect(fetch(link)).rejects.toThrow();
  } finally {
    await phoneBrowser?.close();
    site.close();
    await closeComputerBrowser(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120_000);

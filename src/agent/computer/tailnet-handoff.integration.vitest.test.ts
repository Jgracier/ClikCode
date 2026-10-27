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
<input id="locked" disabled value="fixed" aria-label="Account number"><input id="otp" autocomplete="one-time-code" inputmode="numeric" aria-label="Code">
<select id="sel" aria-label="Plan" onchange="document.title='plan '+this.value"><option value="a">Free</option><option value="b">Pro</option></select>
<input id="when" type="date" aria-label="Start date" onchange="document.title='date '+this.value">
<label><input id="agree" type="checkbox" onchange="document.title='agree '+this.checked"> I agree to the terms</label>
<label><input id="sm" type="radio" name="size" onchange="document.title='size small'"> Small</label><label><input id="lg" type="radio" name="size" onchange="document.title='size large'"> Large</label>
<div id="hov" style="margin:0 20px 10px;height:34px;background:#ddd" onmouseover="document.title='hovered'" oncontextmenu="document.title='context';return false">Hover or right-click</div>
<div id="n"></div><div style="height:3000px"></div>
<script>setInterval(()=>{document.getElementById('n').textContent=String(Date.now()%100000)},40)</script>`;

const wait = async <T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = 6_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (ok(value) || Date.now() > end) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
};

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('shows the tab live on a phone, takes touch and the phone\'s own keyboard, and ends when the user is done', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-tailnet-'));
  // /wide has no mobile layout tag: Chrome lays it out 980px wide and shows it zoomed out, as a phone does.
  const WIDE = '<!doctype html><body style="margin:0"><div style="width:700px;height:1600px;position:relative"><button id="far" style="position:absolute;left:400px;top:900px;width:240px;height:90px" onclick="document.title=\'far hit\'">Verify</button></div>';
  // A frame from another site: `localhost` and `127.0.0.1` are different sites, so Chrome runs the frame in a process of its own, as it does a CAPTCHA.
  const inner = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><body style="margin:0"><button style="margin:10px;width:200px;height:60px" onclick="parent.postMessage(\'hit\', \'*\')">Inside</button>'); });
  await new Promise<void>(resolve => inner.listen(0, '127.0.0.1', resolve));
  const FRAME_PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>frame</title><body style="margin:0"><iframe src="http://localhost:${(inner.address() as AddressInfo).port}/" style="position:absolute;left:20px;top:200px;width:300px;height:120px;border:0"></iframe><div style="height:3000px"></div><script>addEventListener('message', e => { if (e.data === 'hit') document.title = 'frame hit'; });</script>`;
  const site = createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end(request.url === '/wide' ? WIDE : request.url === '/frame' ? FRAME_PAGE : SITE); });
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
    // A computer's browser (a mouse, no touch screen) opens in mouse mode, and the button offers the other one.
    const computerView = await (await phoneBrowser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
    await computerView.goto(link);
    expect(await wait(() => computerView.evaluate(() => (window as unknown as { __handoff: { mode: string } }).__handoff.mode), mode => mode === 'mouse')).toBe('mouse');
    expect(await computerView.locator('#mode').innerText()).toBe('Touch');
    expect(await computerView.locator('#kb').count()).toBe(0);
    await computerView.close();
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

    expect(await wait(() => handoff<number>('h => h.fields'), count => count >= 5)).toBeGreaterThanOrEqual(5);
    expect(await phone.locator('#mode').innerText()).toBe('Mouse');

    // Where a control is, once the page has stopped moving (a mode or a page change re-lays it out): the same answer three times running.
    const settled = async <T,>(read: () => Promise<T>): Promise<T> => {
      let last = '', same = 0, value: T = await read();
      for (let i = 0; i < 60 && same < 3; i++) { await new Promise(resolve => setTimeout(resolve, 60)); value = await read(); const now = JSON.stringify(value); same = now === last ? same + 1 : 0; last = now; }
      return value;
    };
    const tap = async (selector: string): Promise<void> => {
      const box = (await settled(() => page.locator(selector).boundingBox()))!;
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

    // The page's fields are the phone's own inputs, laid over them in the picture: no form page, no bar, no sheet.
    expect(await wait(() => handoff<number>('h => h.overlays'), count => count >= 5)).toBe(5);
    for (const gone of ['#form', '#view', '#sheet', '#accessory', '#proxy', '#kb']) expect(await phone.locator(gone).count(), gone).toBe(0);
    const overlays = phone.locator('#overlays > *');
    const [nameOver, pwOver, otpOver, selOver, dateOver] = [0, 1, 2, 3, 4].map(n => overlays.nth(n));
    for (const [selector, over] of [['#name', nameOver], ['#pw', pwOver], ['#otp', otpOver], ['#sel', selOver], ['#when', dateOver]] as const) {
      const fieldBox = (await settled(() => page.locator(selector).boundingBox()))!;
      const box = (await over.boundingBox())!;
      expect(Math.abs(box.x - (stage.left + fieldBox.x)), selector).toBeLessThan(3);
      expect(Math.abs(box.y - (stage.top + fieldBox.y)), selector).toBeLessThan(3);
      expect(Math.abs(box.width - fieldBox.width), selector).toBeLessThan(3);
      expect(Math.abs(box.height - fieldBox.height), selector).toBeLessThan(3);
      expect(Number(await over.evaluate(node => getComputedStyle(node).opacity)), selector).toBeLessThan(0.1);
    }
    const activeOverlay = (): Promise<number | null> => phone.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a && a.closest('#overlays > *') ? Number(a.dataset.i) : null; });
    expect(await activeOverlay()).toBeNull();

    // A tap on a field is a tap on a real input of the phone: it is focused by the tap itself (nothing in the page asks for it), which is what opens a phone's keyboard.
    await tap('#name');
    expect(await activeOverlay()).not.toBeNull();
    expect(await nameOver.getAttribute('type')).toBe('text');
    await phone.keyboard.type('hello');
    expect(await wait(() => page.locator('#name').inputValue(), value => value === 'hello')).toBe('hello');
    await phone.keyboard.press('Backspace'); await phone.keyboard.press('Backspace');
    expect(await wait(() => page.locator('#name').inputValue(), value => value === 'hel')).toBe('hel');
    await nameOver.fill('replaced by autofill');
    expect(await wait(() => page.locator('#name').inputValue(), value => value === 'replaced by autofill')).toBe('replaced by autofill');
    expect(await wait(() => page.locator('#name').evaluate(node => node === document.activeElement), focused => focused === true)).toBe(true);

    await tap('#pw');
    expect(await pwOver.getAttribute('type')).toBe('password');
    expect(await pwOver.getAttribute('autocomplete')).toBe('current-password');
    await phone.keyboard.type('s3cret');
    expect(await wait(() => page.locator('#pw').inputValue(), value => value === 's3cret')).toBe('s3cret');

    await tap('#otp');
    expect(await otpOver.getAttribute('autocomplete')).toBe('one-time-code');
    expect(await otpOver.getAttribute('inputmode')).toBe('numeric');
    await phone.keyboard.type('123456');
    expect(await wait(() => page.locator('#otp').inputValue(), value => value === '123456')).toBe('123456');

    // A tap somewhere else puts the keyboard away.
    await tap('#n');
    expect(await activeOverlay()).toBeNull();

    // A choice and a date are the phone's own picker, in place; the tap is kept from the page, whose pop-up would open unseen on the computer.
    await tap('#sel');
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).not.toBe('sel');
    expect(await selOver.locator('option').allInnerTexts()).toEqual(['Free', 'Pro']);
    await selOver.selectOption('b');
    expect(await wait(() => page.title(), title => title === 'plan b')).toBe('plan b');
    expect(await dateOver.getAttribute('type')).toBe('date');
    await dateOver.fill('2026-10-27');
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

    // A drag that starts on a field scrolls the page and does not focus the field (the date box above was filled by the test, which left it focused).
    await phone.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await activeOverlay()).toBeNull();
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(() => handoff<number>('h => h.overlays'), count => count === 5);
    const nameBox = (await settled(() => page.locator('#name').boundingBox()))!;
    const fromX = stage.left + nameBox.x + nameBox.width / 2, fromY = stage.top + nameBox.y + nameBox.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y: fromY, id: 1 }] } as never);
    for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fromX, y: fromY - i * 20, id: 1 }] } as never); await new Promise(resolve => setTimeout(resolve, 12)); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as never);
    expect(await wait(() => page.evaluate(() => scrollY), y => y > 100)).toBeGreaterThan(100);
    expect(await activeOverlay()).toBeNull();
    // The flick keeps gliding after the finger lifts: let it stop before the page is put back at the top.
    await settled(() => page.evaluate(() => scrollY));
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await settled(() => page.evaluate(() => scrollY))).toBe(0);

    // A frame from another site (a CAPTCHA, a payment form) takes no emulated touch: a tap on it is delivered as a click, and a drag over it still scrolls.
    await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/frame`);
    const frameBox = (await settled(() => page.locator('iframe').boundingBox()))!;
    await page.evaluate(() => { document.title = 'reset'; });
    await phone.touchscreen.tap(stage.left + frameBox.x + 110, stage.top + frameBox.y + 40);
    expect(await wait(() => page.title(), title => title === 'frame hit')).toBe('frame hit');
    const overX = stage.left + frameBox.x + 150, overY = stage.top + frameBox.y + 60;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: overX, y: overY, id: 1 }] } as never);
    for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: overX, y: overY - i * 20, id: 1 }] } as never); await new Promise(resolve => setTimeout(resolve, 12)); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as never);
    expect(await wait(() => page.evaluate(() => scrollY), y => y > 80)).toBeGreaterThan(80);
    await settled(() => page.evaluate(() => scrollY));
    await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`);
    await wait(() => handoff<number>('h => h.overlays'), count => count === 5);

    // Mouse mode: the page sees a mouse, not a touch screen. A tap clicks, touching a hover target hovers it, two fingers scroll, a two-finger tap right-clicks.
    await page.evaluate(() => window.scrollTo(0, 0));
    await phone.locator('#mode').click();
    expect(await phone.locator('#mode').innerText()).toBe('Touch');
    expect(await wait(() => page.evaluate(() => navigator.maxTouchPoints), points => points === touchBefore)).toBe(touchBefore);
    await page.evaluate(() => { document.title = 'reset'; });
    await tap('#b');
    expect(await wait(() => page.title(), title => title === 'clicked')).toBe('clicked');
    await wait(() => handoff<number>('h => h.overlays'), count => count === 5);
    await tap('#name');
    expect(await activeOverlay()).not.toBeNull();
    await tap('#n');
    expect(await activeOverlay()).toBeNull();
    await page.evaluate(() => { document.title = 'reset'; });
    await tap('#hov');
    expect(await wait(() => page.title(), title => title === 'hovered')).toBe('hovered');
    const twoFingers = async (type: string, y: number, x1 = 100, x2 = 260): Promise<void> => { await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: stage.left + x1, y: stage.top + y, id: 1 }, { x: stage.left + x2, y: stage.top + y, id: 2 }] } as never); };
    const hover = (await page.locator('#hov').boundingBox())!;
    const [rx1, rx2, ry] = [hover.x + 40, hover.x + 140, hover.y + hover.height / 2];
    await page.evaluate(() => { document.title = 'reset'; });
    await twoFingers('touchStart', ry, rx1, rx2); await twoFingers('touchEnd', ry, rx1, rx2);
    expect(await wait(() => page.title(), title => title === 'context')).toBe('context');
    const topBefore = await page.evaluate(() => scrollY);
    await twoFingers('touchStart', 500);
    for (let y = 480; y >= 380; y -= 20) { await twoFingers('touchMove', y); await new Promise(resolve => setTimeout(resolve, 20)); }
    await twoFingers('touchEnd', 380);
    expect(await wait(() => page.evaluate(() => scrollY), y => y > topBefore + 60)).toBeGreaterThan(topBefore + 60);
    // Back to touch.
    await phone.locator('#mode').click();
    expect(await phone.locator('#mode').innerText()).toBe('Mouse');
    expect(await wait(() => page.evaluate(() => navigator.maxTouchPoints), points => points === 5)).toBe(5);
    await page.evaluate(() => { window.scrollTo(0, 0); document.title = 'reset'; });
    await tap('#b');
    expect(await wait(() => page.title(), title => title === 'clicked')).toBe('clicked');

    // A page with no mobile layout tag is laid out wide and shown zoomed out. A tap where the button is drawn must still hit it
    // (it landed above the finger, and a pinch or a drag did nothing), and a pinch must zoom.
    await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/wide`);
    const zoomedOut = await wait(() => page.evaluate(() => visualViewport!.scale), scale => scale < 0.6);
    expect(zoomedOut).toBeLessThan(0.6);
    const drawn = await settled(() => page.evaluate(() => { const v = visualViewport!, r = document.getElementById('far')!.getBoundingClientRect(); return { x: Math.round((r.x + r.width / 2 - v.offsetLeft) * v.scale), y: Math.round((r.y + r.height / 2 - v.offsetTop) * v.scale), s: Math.round(v.scale * 1000) }; }));
    await phone.touchscreen.tap(stage.left + drawn.x, stage.top + drawn.y);
    expect(await wait(() => page.title(), title => title === 'far hit')).toBe('far hit');
    const fingers = async (type: string, a: [number, number], b: [number, number]): Promise<void> => { await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: stage.left + a[0], y: stage.top + a[1], id: 1 }, { x: stage.left + b[0], y: stage.top + b[1], id: 2 }] } as never); };
    await fingers('touchStart', [150, 300], [240, 300]);
    for (let i = 1; i <= 10; i++) { await fingers('touchMove', [150 - i * 7, 300], [240 + i * 8, 300]); await new Promise(resolve => setTimeout(resolve, 16)); }
    await fingers('touchEnd', [0, 0], [0, 0]);
    expect(await wait(() => page.evaluate(() => visualViewport!.scale), scale => scale > zoomedOut * 1.4)).toBeGreaterThan(zoomedOut * 1.4);

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
    inner.close();
    await closeComputerBrowser(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120_000);

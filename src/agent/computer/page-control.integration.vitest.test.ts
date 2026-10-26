/** Page control in real Chrome: history, tabs, scripts, pointer variants, screenshots, scrolling, waits, rich fields, console.
 * Opt in with CLIKCODE_COMPUTER_SMOKE=1 (and CLIKCODE_BROWSER_HOST_ENTRY=<built dist/index.js> when run from a source checkout). */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeComputerBrowser, computerPage } from './browser.js';
import { setComputerEnabled } from './settings.js';
import { computerWebTool } from '../tools/computer-web.js';
import type { ToolContext } from '../tool-contract.js';

const smoke = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
const PASSWORD = 'hunter2-secret-typed';

const PAGE = `<title>Start</title><style>body{margin:0} #box{height:100px;width:300px;overflow:auto;border:1px solid} #wide{width:200px;overflow:auto;white-space:nowrap} #tall{height:2500px}</style>
<button id="ctx" oncontextmenu="document.title='context';return false" ondblclick="document.title='double'" onclick="document.title='click shift='+event.shiftKey">Press me</button>
<canvas id="cv" width="300" height="200" style="display:block;border:1px solid" onclick="document.title='canvas '+event.offsetX+','+event.offsetY"></canvas>
<div id="hov" style="width:100px;height:30px;border:1px solid" onmouseenter="document.title='hovered'">Hover here</div>
<div draggable="true" id="src" ondragstart="event.dataTransfer.setData('text','x')" style="width:80px;height:30px;border:1px solid">Drag me</div>
<div id="dst" ondragover="event.preventDefault()" ondrop="document.title='dropped'" style="width:120px;height:40px;border:1px solid">Drop here</div>
<div id="pad" style="width:200px;height:100px;border:1px solid" onmousedown="window.s=event.offsetX" onmouseup="document.title='dragged '+(event.offsetX-window.s)">Pad</div>
<label>Keys <input id="keys" onkeydown="document.getElementById('last').textContent=(event.ctrlKey?'Control+':'')+(event.shiftKey?'Shift+':'')+event.key"></label><span id="last"></span>
<label>Day <input id="day" type="date" onchange="document.title='day '+this.value"></label>
<label>Time <input id="time" type="time"></label>
<div id="rich" contenteditable="true" role="textbox" aria-label="Editor" style="border:1px solid;min-height:30px" oninput="document.title='rich'"></div>
<label>Notes <textarea id="notes"></textarea></label>
<label>Password <input id="pw" type="password" value="${PASSWORD}"></label>
<label>Secret <input id="code" autocomplete="one-time-code" value="${PASSWORD}-otp"></label>
<div id="box"><div id="tall">top of the box</div></div>
<div id="wide"><div style="width:2000px">wide content</div></div>
<button id="late" disabled>Late button</button><div id="soon" style="display:none">Soon visible</div>
<a href="/second" id="go">Next page</a>
<script>
  setTimeout(() => { document.getElementById('late').disabled = false; document.getElementById('soon').style.display = 'block'; }, 900);
  console.log('hello from page'); console.error('boom ${PASSWORD}');
  setTimeout(() => { throw new Error('late failure'); }, 100);
</script><div style="height:3000px">spacer</div>`;

describe.skipIf(!smoke)('page control in real Chrome', () => {
  let stateDir = '';
  let server: Server;
  let base = '';
  const ctx = (images: boolean): ToolContext => ({ stateDir, acceptsImages: images } as ToolContext);
  const run = (args: Record<string, unknown>, images = false) => computerWebTool.run(args, ctx(images));
  const refOf = (view: string, role: string, name: string): string => new RegExp(`${role} "${name}"[^\\n]*?\\[ref=(\\w+)\\]`).exec(view)?.[1] ?? '';
  const title = async (): Promise<string> => (await computerPage(stateDir)).title();
  let view = '';

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-page-control-'));
    server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(request.url === '/second' ? '<title>Second</title><h1>Second page</h1><button onclick="window.open(\'/third\')">Pop</button>' : request.url === '/third' ? '<title>Third</title><h1>Third page</h1>' : PAGE);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await setComputerEnabled(stateDir, true);
    view = (await run({ action: 'open', url: `${base}/` })).output;
  }, 60_000);
  afterAll(async () => {
    server?.close();
    if (stateDir) { await closeComputerBrowser(stateDir); await rm(stateDir, { recursive: true, force: true }); }
  }, 30_000);

  it('goes forward, back and reloads, and says so when there is no history', async () => {
    const link = refOf(view, 'link', 'Next page');
    expect(link).toBeTruthy();
    await run({ action: 'click', target: link });
    expect(await title()).toBe('Second');
    const back = await run({ action: 'back' });
    expect(back.output).toContain('Went back');
    expect(await title()).toBe('Start');
    const forward = await run({ action: 'forward' });
    expect(forward.output).toContain('Second page');
    expect((await run({ action: 'reload' })).output).toContain('Reloaded');
    // A new tab starts on about:blank, so history runs out one step before the start page.
    await run({ action: 'back' });
    expect((await run({ action: 'back' })).output).toContain('about:blank');
    const none = await run({ action: 'back' });
    expect(none.isError).toBe(true);
    expect(none.output).toContain('no earlier page');
    await run({ action: 'forward' });
    expect(await title()).toBe('Start');
    view = (await run({ action: 'observe' })).output;
  }, 60_000);

  it('lists, switches and closes only its own tabs', async () => {
    await run({ action: 'open', url: `${base}/second`, new_tab: true });
    const listed = (await run({ action: 'tabs' })).output;
    expect(listed).toMatch(/\* 1: "Second"/);
    expect(listed).toMatch(/ {2}0: "Start"/);
    const switched = await run({ action: 'switch', index: 0 });
    expect(switched.output).toContain('Switched tabs');
    expect(await title()).toBe('Start');
    expect((await run({ action: 'switch', text: 'second' })).output).toContain('Second page');
    expect((await run({ action: 'switch', index: 7 })).isError).toBe(true);
    const closed = await run({ action: 'close', index: 1 });
    expect(closed.output).toContain('Closed the tab');
    expect((await run({ action: 'tabs' })).output).not.toContain('Second');
    // Back on the first tab, and a second chat's tab is not listed.
    expect(await title()).toBe('Start');
    const other = await run({ action: 'open', url: `${base}/second`, tab: 'other-chat' });
    expect(other.isError).toBeUndefined();
    expect((await run({ action: 'tabs' })).output).not.toContain('Second');
    await run({ action: 'close', tab: 'other-chat' });
    view = (await run({ action: 'observe' })).output;
  }, 60_000);

  it('evaluates scripts, hides credential values, and refuses to go looking for them', async () => {
    expect((await run({ action: 'evaluate', expression: 'document.title' })).output).toBe('"Start"');
    expect((await run({ action: 'evaluate', expression: '({ n: 1 + 1, list: [1, 2] })' })).output).toContain('"n": 2');
    expect((await run({ action: 'evaluate', expression: '(async () => { await new Promise(r => setTimeout(r, 50)); return 7; })()' })).output).toBe('7');
    const withElement = await run({ action: 'evaluate', expression: 'el => el.textContent', target: refOf(view, 'button', 'Press me') });
    expect(withElement.output).toBe('"Press me"');
    // A credential field reads as empty to the script, and anything built from it is hidden.
    const read = await run({ action: 'evaluate', expression: 'Array.from(document.querySelectorAll("input")).map(i => i.value).join("|")' });
    expect(read.output).not.toContain(PASSWORD);
    const direct = await run({ action: 'evaluate', expression: 'document.querySelector("#pw").value' });
    expect(direct.isError).toBeUndefined();
    expect(direct.output).toBe('""');
    const refused = await run({ action: 'evaluate', expression: 'document.querySelector("input[type=password]").value' });
    expect(refused.isError).toBe(true);
    expect(refused.output).not.toContain(PASSWORD);
    const viaProto = await run({ action: 'evaluate', expression: 'Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").get.call(document.querySelector("#pw"))' });
    expect(viaProto.isError).toBe(true);
    // A value that leaks through the page's own text is still hidden.
    const echoed = await run({ action: 'evaluate', expression: 'document.body.innerHTML.length > 0 ? document.querySelector("#pw").getAttribute("value") : ""' });
    expect(echoed.output).not.toContain(PASSWORD);
    const failure = await run({ action: 'evaluate', expression: 'nothing.here' });
    expect(failure.isError).toBe(true);
    expect(failure.output).toContain('nothing is not defined');
    // The field is back to normal afterwards.
    expect(await (await computerPage(stateDir)).locator('#pw').inputValue()).toBe(PASSWORD);
  }, 60_000);

  it('clicks with other buttons, counts, modifiers and canvas coordinates, and hovers', async () => {
    const press = refOf(view, 'button', 'Press me');
    await run({ action: 'click', target: press, button: 'right' });
    expect(await title()).toBe('context');
    await run({ action: 'click', target: press, count: 2 });
    expect(await title()).toBe('double');
    await run({ action: 'click', target: press, modifiers: ['Shift'] });
    expect(await title()).toBe('click shift=true');
    const page = await computerPage(stateDir);
    const box = (await page.locator('#cv').boundingBox())!;
    const at = await run({ action: 'click', x: Math.round(box.x) + 40, y: Math.round(box.y) + 25 });
    expect(at.output).toContain('Clicked at');
    expect(await title()).toMatch(/^canvas 3\d,2\d$|^canvas 4\d,2\d$|^canvas 39,24$|^canvas 40,25$/);
    expect((await run({ action: 'hover', target: refOf(view, 'generic', 'Hover here') || 'Hover here' })).output).toContain('Hovered');
    expect(await title()).toBe('hovered');
    expect((await run({ action: 'click', button: 'back' })).isError).toBe(true);
  }, 60_000);

  it('drags between elements and between points', async () => {
    const drop = await run({ action: 'drag', target: 'Drag me', to_target: 'Drop here' });
    expect(drop.output).toContain('Dragged');
    expect(await title()).toBe('dropped');
    const page = await computerPage(stateDir);
    const box = (await page.locator('#pad').boundingBox())!;
    await run({ action: 'drag', x: Math.round(box.x) + 20, y: Math.round(box.y) + 40, to_x: Math.round(box.x) + 120, to_y: Math.round(box.y) + 40 });
    expect(await title()).toBe('dragged 100');
    expect((await run({ action: 'drag', target: 'Drag me' })).isError).toBe(true);
  }, 60_000);

  it('presses characters, names and combinations, and refuses what is not a key', async () => {
    const field = refOf(view, 'textbox', 'Keys');
    await run({ action: 'click', target: field });
    const last = async (): Promise<string> => (await computerPage(stateDir)).locator('#last').innerText();
    for (const [key, shown] of [['/', '/'], ['.', '.'], ['Control+a', 'Control+a'], ['Shift+Tab', 'Tab'], ['x', 'x'], [' ', ' ']] as const) {
      const result = await run({ action: 'press', key });
      expect(result.isError, `${key}: ${result.output}`).toBeUndefined();
      if (key !== 'Shift+Tab') expect(await last()).toBe(shown);
      await run({ action: 'click', target: field });
    }
    for (const bad of ['', 'Control+', 'rm -rf', 'Foo+a', 'a\nb', 'Control+Shift+Alt+Meta+a+b']) expect((await run({ action: 'press', key: bad })).isError, bad).toBe(true);
    // Meta+k and a step inside steps use the same check.
    expect((await run({ action: 'press', key: 'Meta+k' })).isError).toBeUndefined();
    const batch = await run({ action: 'steps', steps: [{ do: 'press', key: 'Escape' }, { do: 'press', key: '$$' }] });
    expect(batch.isError).toBe(true);
    expect(batch.output).toContain('Step 2');
  }, 60_000);

  it('scrolls by amount, to the edges, sideways, inside an element, and an element into view', async () => {
    const page = await computerPage(stateDir);
    const down = await run({ action: 'scroll', direction: 'down', amount: 300 });
    expect(down.output).toContain('Scrolled down by 300px');
    expect(await page.evaluate(() => window.scrollY)).toBe(300);
    const up = await run({ action: 'scroll', direction: 'up', amount: 100 });
    expect(up.output).toContain('now down 200');
    expect((await run({ action: 'scroll', direction: 'bottom' })).output).toContain('at the end');
    expect((await run({ action: 'scroll', direction: 'top' })).output).toContain('at the start');
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // Inside the box, not the page.
    const inside = await run({ action: 'scroll', target: 'top of the box', direction: 'down', amount: 400 });
    expect(inside.output).toContain('inside');
    expect(await page.evaluate(() => (document.getElementById('box') as HTMLElement).scrollTop)).toBe(400);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await run({ action: 'scroll', target: 'top of the box', direction: 'right', amount: 50 });
    // Horizontal scrolling on the page's wide element, then an element into view.
    const intoView = await run({ action: 'scroll', target: 'Next page' });
    expect(intoView.output).toContain('into view');
    await run({ action: 'scroll', direction: 'top' });
  }, 60_000);

  it('waits for network idle, element states, a url change, and text', async () => {
    expect((await run({ action: 'wait', until: 'network_idle' })).output).toContain('network is idle');
    const page = await computerPage(stateDir);
    // The late button turns enabled after about a second; the hidden block appears.
    await page.reload();
    const state = await run({ action: 'wait', until: 'visible', selector: '#soon', seconds: 10 });
    expect(state.output).toContain('#soon is visible');
    expect((await run({ action: 'wait', until: 'enabled', selector: '#late', seconds: 10 })).output).toContain('is enabled');
    expect((await run({ action: 'wait', until: 'hidden', selector: '#does-not-exist', seconds: 2 })).output).toContain('is hidden');
    const stuck = await run({ action: 'wait', until: 'visible', selector: '#does-not-exist', seconds: 1 });
    expect(stuck.output).toContain('still not visible');
    // A url change: click the link a moment from now.
    setTimeout(() => { void page.locator('#go').click(); }, 400);
    const moved = await run({ action: 'wait', until: 'url', url: '/second', seconds: 10 });
    expect(moved.output).toContain('/second');
    await run({ action: 'back' });
    setTimeout(() => { void page.locator('#go').click(); }, 400);
    expect((await run({ action: 'wait', until: 'url', seconds: 10 })).output).toContain('The address is now');
    await run({ action: 'back' });
    expect((await run({ action: 'wait', text: 'Late button', seconds: 5 })).output).toContain('Appeared');
    view = (await run({ action: 'observe' })).output;
  }, 90_000);

  it('fills rich-text editors, date and time boxes, textareas and very long text', async () => {
    const page = await computerPage(stateDir);
    const editor = refOf(view, 'textbox', 'Editor');
    const filled = await run({ action: 'fill', target: editor, text: 'First line\nSecond line' });
    expect(filled.isError).toBeUndefined();
    expect(await page.locator('#rich').innerText()).toBe('First line\nSecond line');
    await run({ action: 'fill', target: editor, text: 'Replaced' });
    expect(await page.locator('#rich').innerText()).toBe('Replaced');
    await run({ action: 'fill', target: refOf(view, 'textbox', 'Day') || 'Day', text: '10/26/2026' });
    expect(await page.locator('#day').inputValue()).toBe('2026-10-26');
    expect(await title()).toBe('day 2026-10-26');
    await run({ action: 'fill', target: 'Time', text: '3:45 PM' });
    expect(await page.locator('#time').inputValue()).toBe('15:45');
    const bad = await run({ action: 'fill', target: 'Day', text: 'next tuesday' });
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain('YYYY-MM-DD');
    const long = 'long text. '.repeat(8_000);
    const result = await run({ action: 'fill', target: 'Notes', text: long });
    expect(result.isError).toBeUndefined();
    expect(await page.locator('#notes').inputValue()).toBe(long);
    expect((await run({ action: 'fill', target: 'Notes', text: 'x'.repeat(100_001) })).isError).toBe(true);
  }, 90_000);

  it('returns console messages and page errors, scrubbed', async () => {
    const page = await computerPage(stateDir);
    await page.reload();
    await page.waitForTimeout(500);
    const all = (await run({ action: 'console' })).output;
    expect(all).toContain('[log] hello from page');
    expect(all).toContain('late failure');
    expect(all).not.toContain(PASSWORD);
    const errors = (await run({ action: 'console', level: 'error' })).output;
    expect(errors).toContain('[pageerror]');
    expect(errors).not.toContain('hello from page');
    expect((await run({ action: 'console', find: 'hello', clear: true })).output).toContain('hello from page');
    expect((await run({ action: 'console' })).output).toContain('empty');
  }, 60_000);

  it('takes screenshots, and withholds them while a credential holds a value', async () => {
    const page = await computerPage(stateDir);
    // With the password in the page, nothing is shown.
    const withheld = await run({ action: 'screenshot' }, true);
    expect(withheld.images).toBeUndefined();
    expect(withheld.output).toContain('withheld');
    expect((await run({ action: 'click', target: 'Press me', with_screenshot: true }, true)).images).toBeUndefined();
    await page.evaluate(() => { for (const id of ['pw', 'code']) (document.getElementById(id) as HTMLInputElement).value = ''; });
    const shot = await run({ action: 'screenshot' }, true);
    expect(shot.images?.[0]?.mimeType).toBe('image/jpeg');
    const element = await run({ action: 'screenshot', target: 'Hover here' }, true);
    expect(element.images?.length).toBe(1);
    expect(element.images![0]!.data.length).toBeLessThan(shot.images![0]!.data.length);
    const full = await run({ action: 'screenshot', full: true }, true);
    expect(full.images![0]!.data.length).toBeGreaterThan(0);
    const withAction = await run({ action: 'hover', target: 'Hover here', with_screenshot: true }, true);
    expect(withAction.images?.length).toBe(1);
    expect((await run({ action: 'screenshot' }, false)).output).toContain('cannot show images');
    expect((await run({ action: 'hover', target: 'Hover here', with_screenshot: true }, false)).images).toBeUndefined();
  }, 60_000);
});

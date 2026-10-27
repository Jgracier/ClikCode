/** The live view of one tab for a phone, over the DevTools protocol: Chrome pushes screen frames as it paints them, the page is laid out for the
 * phone's own size and touch screen so it reflows instead of being shrunk, and what the phone does reaches the page as real touch, mouse and key
 * events. The page's fields are told to the phone with where each is on its screen, so the phone can lay a real input over each one: a finger
 * on a field then lands on a real input of the phone's own (its keyboard, autofill and pickers), and what is entered is filled into the page. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { CDPSession, Page } from 'playwright-core';
import { cleanPoints, cleanSize, keyEvent, MAX_REPEAT, MAX_TEXT, OUTSIDE, type KeyEvent, type Size } from './handoff-input.js';
import type { LiteSocket } from './ws-lite.js';

/** Runs in every page of the tab: says what a control is, as what the phone needs to show a matching one. A password's value is never read. */
export const DESCRIBE_SCRIPT = `(() => {
  if (window.__clikDescribe) return;
  const TEXT = /^(text|search|url|tel|email|password|number)$/;
  const NATIVE = /^(date|time|datetime-local|month|week|color)$/;
  const clean = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
  const label = (e) => clean((e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.getAttribute('title') || e.placeholder || e.name).slice(0, 100);
  const common = (e) => ({ label: label(e), required: Boolean(e.required), inputmode: e.inputMode || e.getAttribute('inputmode') || '', autocomplete: e.getAttribute('autocomplete') || '', enterkeyhint: e.enterKeyHint || e.getAttribute('enterkeyhint') || '', maxlength: e.maxLength > 0 ? e.maxLength : 0, placeholder: clean(e.placeholder).slice(0, 80) });
  window.__clikDescribe = (e) => {
    if (!e || e === document.body || e === document.documentElement) return null;
    if (e.tagName === 'SELECT') return { kind: 'select', multiple: e.multiple, required: Boolean(e.required), label: label(e), options: Array.from(e.options).slice(0, 300).map((o) => ({ v: o.value, t: clean(o.text).slice(0, 100), s: o.selected, d: o.disabled })) };
    if (e.tagName === 'TEXTAREA') return { kind: 'text', type: 'textarea', multiline: true, value: e.value.slice(0, 2000), ...common(e) };
    if (e.tagName === 'INPUT') {
      const type = (e.type || 'text').toLowerCase();
      if (TEXT.test(type)) return { kind: 'text', type, value: type === 'password' ? '' : e.value.slice(0, 1000), ...common(e) };
      if (NATIVE.test(type)) return { kind: 'native', type, value: e.value, min: e.min, max: e.max, step: e.step, ...common(e) };
      return null;
    }
    if (e.isContentEditable) return { kind: 'text', type: 'editable', multiline: true, value: (e.innerText || '').slice(0, 2000), ...common(e) };
    return null;
  };
})();`;

/** The fields on the page a person can fill, in the page's order, with where each is on the phone's screen. Each keeps one number for as long as
 * the page keeps it, and the elements are remembered by it, so the phone can name one. */
export const FIELDS_SCRIPT = `(() => {
  const describe = window.__clikDescribe;
  const v = window.visualViewport;
  if (!describe || !v) return '[]';
  const s = v.scale, ox = v.offsetLeft, oy = v.offsetTop;
  const KIND = /^(text|search|url|tel|email|password|number|date|time|datetime-local|month|week|color)$/;
  const byId = {}, out = [];
  for (const e of document.querySelectorAll('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
    if (out.length >= 60) break;
    if (e.disabled || e.readOnly) continue;
    if (e.tagName === 'INPUT' && !KIND.test((e.type || 'text').toLowerCase())) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    // Something else drawn over it (a dialog, a menu): not a field a tap would reach. Only checked where the field is on screen.
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== e && !e.contains(top) && !top.contains(e) && !(top.closest && top.closest('label') && top.closest('label').control === e)) continue;
    }
    const d = describe(e);
    if (!d) continue;
    if (e.__clikId === undefined) e.__clikId = (window.__clikNext = (window.__clikNext || 0) + 1);
    byId[e.__clikId] = e;
    d.idx = e.__clikId;
    if (d.options && d.options.length > 200) d.options = d.options.slice(0, 200);
    const round = (n) => Math.round(n * 10) / 10;
    out.push({ i: d.idx, x: round((r.left - ox) * s), y: round((r.top - oy) * s), w: round(r.width * s), h: round(r.height * s), d });
  }
  window.__clikFields = byId;
  return JSON.stringify(out);
})()`;

/** Puts the caret in a control and selects what is in it, so what is typed next replaces it. */
const prepareFill = (index: number): string => `((index) => {
  const e = (window.__clikFields || [])[index];
  if (!e) return 'gone';
  if (e.disabled || e.readOnly) return 'locked';
  e.focus();
  try { if (typeof e.select === 'function') e.select(); else if (e.isContentEditable) document.execCommand('selectAll'); } catch (error) { /* a field that cannot select */ }
  return 'ok';
})(${index})`;

/** Sets a select, a date or a colour from the phone's native control, the way a person choosing it would (the page hears input and change). */
const setValueExpression = (value: string | string[], index: number): string => `((value, index) => {
  const e = (index >= 0 && (window.__clikFields || [])[index]) || document.activeElement;
  if (!e || e.disabled) return false;
  if (e.tagName === 'SELECT') {
    const wanted = Array.isArray(value) ? value : [value];
    for (const o of Array.from(e.options)) o.selected = wanted.includes(o.value);
  } else {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value');
    if (setter && setter.set) setter.set.call(e, String(value)); else e.value = String(value);
  }
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})(${JSON.stringify(value)}, ${index})`;

type Message = { t?: string; [key: string]: unknown };

/** Where the phone's screen sits in the page. Chrome reads input positions as the page's own (layout) pixels, but the phone shows the
 * page through a visual viewport that can be zoomed out (a page with no mobile layout tag is laid out 980px wide and shown at about 0.4)
 * or pinched in and panned. A finger at (x, y) on the screen is at offset + (x, y) / scale in the page. Sent as-is, a tap lands above and
 * left of the finger, by more the lower and further right it is, and pinch and drag do nothing. */
export interface PageView { scale: number; x: number; y: number }
export const SAME_VIEW: PageView = { scale: 1, x: 0, y: 0 };
export function toPage(view: PageView, x: number, y: number): { x: number; y: number } {
  const scale = view.scale > 0.05 && view.scale < 20 ? view.scale : 1;
  return { x: view.x + x / scale, y: view.y + y / scale };
}
const READ_VIEW = '({ scale: visualViewport.scale, x: visualViewport.offsetLeft, y: visualViewport.offsetTop })';

const BUTTONS = ['left', 'middle', 'right'] as const;

export class LiveView {
  private cdp: CDPSession | undefined;
  private size: Size | undefined;
  private stopped = false;
  private scriptId: string | undefined;
  /** The phone has drawn the last frame it was sent and wants another. */
  private ready = true;
  private held: { data: string; sessionId: number } | undefined;
  private unstick: NodeJS.Timeout | undefined;
  private queue: Message[] = [];
  private draining = false;
  private streaming = false;
  /** Chrome side is set up (domains on, field tracking installed): queued messages may run. */
  private up = false;
  private lastView: PageView = SAME_VIEW;
  /** A finger that went down on a frame from another site and has not yet moved: it is a click if it lifts, a scroll if it moves. */
  private foreign: { start: { x: number; y: number }; screen: { x: number; y: number; id: number }; scrolling?: boolean; last?: { x: number; y: number } } | undefined;
  /** What the phone's finger is: touch (the page sees a touch screen, laid out for the phone) or a mouse (the page sees a pointer). */
  private mode: 'touch' | 'mouse' = 'touch';
  private laidOutAs: 'touch' | 'mouse' | undefined;
  private fieldsTimer: NodeJS.Timeout | undefined;
  private lastFields = '';
  /** What happened, for tests and for the phone's status line. */
  readonly stats = { frames: 0, restarts: 0 };

  constructor(private readonly page: Page, private readonly socket: LiteSocket, private readonly finish: () => void, private readonly activity: () => void = () => undefined) {
    // Listening starts now, not when Chrome is ready: what the phone sends first (its size) waits in the queue.
    socket.onMessage((data, binary) => { if (!binary) this.accept(String(data)); });
    socket.onClose(() => { void this.stop(); });
  }

  async start(): Promise<void> {
    const cdp = await this.page.context().newCDPSession(this.page);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => { void this.onFrame(frame); });
    cdp.on('Page.frameNavigated', (event: { frame: { parentId?: string; url: string } }) => { if (!event.frame.parentId) this.sendPage(event.frame.url); });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: DESCRIBE_SCRIPT }) as { identifier: string };
    this.scriptId = added.identifier;
    await cdp.send('Runtime.evaluate', { expression: DESCRIBE_SCRIPT }).catch(quiet('agent/computer/handoff-live'));
    await this.page.bringToFront().catch(quiet('agent/computer/handoff-live'));
    this.sendPage(this.page.url());
    this.up = true;
    void this.drain();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.unstick);
    clearTimeout(this.fieldsTimer);
    const cdp = this.cdp;
    if (!cdp) return;
    const quietly = quiet('agent/computer/handoff-live');
    await cdp.send('Page.stopScreencast').catch(quietly);
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(quietly);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(quietly);
    if (this.scriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId }).catch(quietly);
    await cdp.detach().catch(quietly);
  }

  // ── from the phone ────────────────────────────────────────────────────────

  private accept(text: string): void {
    let message: Message;
    try { message = JSON.parse(text) as Message; } catch { return; }
    if (!message || typeof message !== 'object' || typeof message.t !== 'string') return;
    this.activity();
    if (message.t === 'ack') { this.onAck(); return; }
    // A stream of moves only matters at its latest point: a slow page must not make the phone's finger lag behind by a queue of them.
    const last = this.queue.at(-1);
    if (last && ((message.t === 'touch' && message.k === 'm' && last.t === 'touch' && last.k === 'm') || (message.t === 'mouse' && message.k === 'm' && last.t === 'mouse' && last.k === 'm') || (message.t === 'resize' && last.t === 'resize') || (message.t === 'fill' && last.t === 'fill' && message.i === last.i))) this.queue[this.queue.length - 1] = message;
    else this.queue.push(message);
    if (this.queue.length > 400) this.queue.splice(0, this.queue.length - 400);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.up) return;
    this.draining = true;
    try {
      for (let message = this.queue.shift(); message && !this.stopped; message = this.queue.shift()) {
        await this.handle(message).catch(quiet('agent/computer/handoff-live'));
        if (message.t !== 'hello' && message.t !== 'resize' && message.t !== 'done') this.scheduleFields(80);
      }
    } finally { this.draining = false; }
  }

  private async handle(message: Message): Promise<void> {
    const cdp = this.cdp!;
    switch (message.t) {
      case 'hello': case 'resize': {
        this.mode = message.m === 'mouse' ? 'mouse' : 'touch';
        const size = cleanSize(message);
        if (size) await this.layout(size);
        return;
      }
      case 'touch': {
        const points = cleanPoints(message.p);
        const type = ({ s: 'touchStart', m: 'touchMove', e: 'touchEnd', c: 'touchCancel' } as Record<string, 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel'>)[String(message.k)];
        if (!points || !type) return;
        const view = this.lastView = await this.view();
        const mapped = points.map(point => ({ ...toPage(view, point.x, point.y), id: point.id }));
        // A frame from another site (a CAPTCHA, a payment form) runs in a process of its own, and Chrome does not pass emulated touch into it; it does
        // pass a mouse click. So a finger that goes down on one waits: lifted without moving it clicks, moved it is a touch and scrolls as usual.
        if (type === 'touchStart' && points.length === 1 && !this.foreign && await this.overForeignFrame(mapped[0]!.x, mapped[0]!.y)) {
          this.foreign = { start: { x: mapped[0]!.x, y: mapped[0]!.y }, screen: { x: points[0]!.x, y: points[0]!.y, id: points[0]!.id } };
          return;
        }
        if (this.foreign) {
          const waiting = this.foreign;
          if (type === 'touchEnd' || type === 'touchCancel') {
            this.foreign = undefined;
            if (type === 'touchEnd' && points.length === 0 && !waiting.scrolling) await this.click(waiting.start.x, waiting.start.y);
            return;
          }
          // A drag that began on the frame scrolls the page itself, one for one with the finger: the frame is handed the whole touch and does not pass the scroll on.
          if (waiting.scrolling || (points.length === 1 && Math.hypot(points[0]!.x - waiting.screen.x, points[0]!.y - waiting.screen.y) > 10)) {
            if (points.length === 1) {
              const from = waiting.last ?? waiting.screen, now = points[0]!, scale = view.scale > 0.05 ? view.scale : 1;
              waiting.scrolling = true; waiting.last = { x: now.x, y: now.y };
              await this.evaluate(`window.scrollBy(${(from.x - now.x) / scale}, ${(from.y - now.y) / scale})`);
              return;
            }
          }
          const moved = points.length !== 1;
          if (!moved) return;
          // Two fingers (a pinch) are a gesture of their own: the touch is replayed from where it began.
          this.foreign = undefined;
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: waiting.start.x, y: waiting.start.y, id: waiting.screen.id }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: mapped });
        return;
      }
      case 'mouse': {
        const x = Number(message.x), y = Number(message.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < -OUTSIDE || y < -OUTSIDE || x > 20_000 || y > 20_000) return;
        const view = this.lastView = await this.view();
        const at = toPage(view, x, y);
        const button = BUTTONS[Number(message.b)] ?? 'left';
        const mask = { left: 1, middle: 4, right: 2 }[button];
        if (message.k === 'w') { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: Math.max(-2000, Math.min(2000, Number(message.dx) || 0)), deltaY: Math.max(-2000, Math.min(2000, Number(message.dy) || 0)) }); return; }
        const type = ({ d: 'mousePressed', u: 'mouseReleased', m: 'mouseMoved' } as Record<string, 'mousePressed' | 'mouseReleased' | 'mouseMoved'>)[String(message.k)];
        if (!type) return;
        await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' && !message.down ? 'none' : button, buttons: type === 'mouseReleased' ? 0 : (type === 'mousePressed' || message.down ? mask : 0), clickCount: type === 'mouseMoved' ? 0 : 1 });
        return;
      }
      case 'key': {
        const key = keyEvent(message.key);
        if (key) await this.pressKey(key, Math.max(1, Math.min(MAX_REPEAT, Math.floor(Number(message.n) || 1))));
        return;
      }
      case 'fill': {
        // The whole value of one field, as a person typing it would put it in (the page hears real input).
        const index = Number(message.i), value = message.v;
        if (!Number.isInteger(index) || index < 0 || typeof value !== 'string' || value.length > MAX_TEXT) return;
        if (await this.evaluate<string>(prepareFill(index)) !== 'ok') return;
        if (value === '') await this.pressKey(keyEvent('Backspace')!, 1);
        else await cdp.send('Input.insertText', { text: value });
        return;
      }
      case 'set': {
        const value = message.v;
        const ok = typeof value === 'string' ? value.length <= 2_000 : Array.isArray(value) && value.length <= 300 && value.every(item => typeof item === 'string' && item.length <= 2_000);
        if (ok) await cdp.send('Runtime.evaluate', { expression: setValueExpression(value as string | string[], Number.isInteger(message.i) ? Number(message.i) : -1) });
        return;
      }
      case 'done': this.finish(); return;
      default: return;
    }
  }

  // ── to the phone ──────────────────────────────────────────────────────────

  private send(message: Message): void { if (!this.socket.closed) this.socket.send(JSON.stringify(message)); }

  private sendPage(url: string): void {
    let host = '';
    try { host = new URL(url).host; } catch { host = ''; }
    this.send({ t: 'page', host });
  }

  private async evaluate<T>(expression: string): Promise<T | undefined> {
    try {
      const result = await this.cdp!.send('Runtime.evaluate', { expression, returnByValue: true }) as { result?: { value?: T } };
      return result.result?.value;
    } catch { return undefined; }
  }

  private async pressKey(key: KeyEvent, times: number): Promise<void> {
    const cdp = this.cdp!;
    for (let i = 0; i < times; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk, ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}) });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk });
    }
  }

  /** Whether a point of the page is over a frame from another site (its document cannot be read from here). */
  private async overForeignFrame(x: number, y: number): Promise<boolean> {
    const result = await this.evaluate<boolean>(`((x, y) => { const e = document.elementFromPoint(x, y); if (!e || e.tagName !== 'IFRAME') return false; try { return !e.contentDocument; } catch (error) { return true; } })(${x}, ${y})`);
    return result === true;
  }

  private async click(x: number, y: number): Promise<void> {
    const cdp = this.cdp!;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  /** The visual viewport right now, read before each input so a pinch or a pan that just happened is already in the next position. */
  private async view(): Promise<PageView> {
    try {
      const result = await this.cdp!.send('Runtime.evaluate', { expression: READ_VIEW, returnByValue: true }) as { result?: { value?: PageView } };
      const value = result.result?.value;
      if (value && Number.isFinite(value.scale) && Number.isFinite(value.x) && Number.isFinite(value.y)) return value;
    } catch { /* the page is changing: the last good view is the best there is */ }
    return this.lastView;
  }

  private async layout(size: Size): Promise<void> {
    const cdp = this.cdp!;
    const same = this.size && this.size.w === size.w && this.size.h === size.h && this.size.dpr === size.dpr && this.laidOutAs === this.mode;
    this.size = size;
    if (same && this.streaming) return;
    const touch = this.mode === 'touch';
    this.laidOutAs = this.mode;
    // A mouse sees the page at the phone's width at full size; a finger sees the mobile layout (zoomed out for a page with no layout tag, pinchable).
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: size.dpr, mobile: touch });
    await cdp.send('Emulation.setTouchEmulationEnabled', touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    // Frames at the screen's own density up to 2x: a phone's 3x costs more to send than the eye can tell from 2x.
    const scale = Math.min(size.dpr, 2);
    if (this.streaming) await cdp.send('Page.stopScreencast').catch(quiet('agent/computer/handoff-live'));
    this.held = undefined;
    this.ready = true;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: Math.round(size.w * scale), maxHeight: Math.round(size.h * scale), everyNthFrame: 1 });
    this.streaming = true;
    this.stats.restarts++;
    this.send({ t: 'size', w: size.w, h: size.h });
    this.scheduleFields(250);
  }

  /** One frame in flight at a time: Chrome is told a frame was received only once it has gone to the phone, so it paints no faster than the phone draws, and the phone always gets the newest. */
  private async onFrame(frame: { data: string; sessionId: number }): Promise<void> {
    if (this.stopped || this.socket.closed) return;
    if (!this.ready || this.socket.buffered > 400_000) {
      if (this.held) await this.ackChrome(this.held.sessionId);
      this.held = frame;
      return;
    }
    await this.deliver(frame);
  }

  private async deliver(frame: { data: string; sessionId: number }): Promise<void> {
    this.ready = false;
    this.stats.frames++;
    this.scheduleFields();
    this.socket.send(Buffer.concat([Buffer.from([1]), Buffer.from(frame.data, 'base64')]));
    await this.ackChrome(frame.sessionId);
    clearTimeout(this.unstick);
    // A phone that never answers (backgrounded, asleep) must not stop the stream for good.
    this.unstick = setTimeout(() => { this.ready = true; const held = this.held; if (held) { this.held = undefined; void this.deliver(held); } }, 1_500);
  }

  private onAck(): void {
    clearTimeout(this.unstick);
    this.ready = true;
    const held = this.held;
    if (held) { this.held = undefined; void this.deliver(held); }
  }

  /** Tells the phone where the page's fields are, when that changed: after frames (the page moved) and after input. */
  private scheduleFields(delay = 140): void {
    if (this.fieldsTimer || this.stopped) return;
    this.fieldsTimer = setTimeout(() => { this.fieldsTimer = undefined; void this.refreshFields(); }, delay);
  }

  private async refreshFields(): Promise<void> {
    if (this.stopped || this.socket.closed || !this.cdp) return;
    try {
      const result = await this.cdp.send('Runtime.evaluate', { expression: FIELDS_SCRIPT, returnByValue: true }) as { result?: { value?: string } };
      const text = result.result?.value;
      if (typeof text !== 'string' || text === this.lastFields) return;
      this.lastFields = text;
      this.send({ t: 'fields', f: JSON.parse(text) as unknown });
    } catch { /* the page is changing */ }
  }

  private async ackChrome(sessionId: number): Promise<void> {
    await this.cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  }
}

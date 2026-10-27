/** The live view of one tab for a phone, over the DevTools protocol: Chrome pushes screen frames as it paints them, the page is laid out for the
 * phone's own size and touch screen (so it reflows instead of being shrunk), and what the phone does reaches the page as real touch, mouse and key
 * events. The phone's own keyboard is used for text: this tells it when a field takes focus and what kind of field it is. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { CDPSession, Page } from 'playwright-core';
import { cleanPoints, cleanSize, keyEvent, MAX_REPEAT, MAX_TEXT, type Size } from './handoff-input.js';
import type { LiteSocket } from './ws-lite.js';

/** Runs in every page of the tab: reports which field has focus, as what the phone needs to show a matching one. A password's value is never read. */
export const FOCUS_SCRIPT = `(() => {
  if (window.__clikFocusInstalled) return;
  window.__clikFocusInstalled = true;
  const TEXT = /^(text|search|url|tel|email|password|number)$/;
  const NATIVE = /^(date|time|datetime-local|month|week|color|range)$/;
  const label = (e) => ((e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.placeholder || e.name || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const common = (e) => ({ label: label(e), inputmode: e.inputMode || e.getAttribute('inputmode') || '', autocomplete: e.getAttribute('autocomplete') || '', enterkeyhint: e.enterKeyHint || e.getAttribute('enterkeyhint') || '', maxlength: e.maxLength > 0 ? e.maxLength : 0 });
  const describe = (e) => {
    if (!e || e === document.body || e === document.documentElement) return null;
    if (e.tagName === 'SELECT') return { kind: 'select', multiple: e.multiple, label: label(e), options: Array.from(e.options).slice(0, 300).map((o) => ({ v: o.value, t: o.text.replace(/\\s+/g, ' ').trim().slice(0, 100), s: o.selected, d: o.disabled })) };
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
  let last = 'null';
  const report = () => {
    if (window !== window.top) return;
    const text = JSON.stringify(describe(document.activeElement));
    if (text === last) return;
    last = text;
    if (typeof window.__clikFocus === 'function') window.__clikFocus(text);
  };
  document.addEventListener('focusin', () => setTimeout(report, 0), true);
  document.addEventListener('focusout', () => setTimeout(report, 40), true);
  report();
})();`;

/** After a field takes focus the caret goes to its end: what the phone types is replayed from there. */
const CARET_TO_END = `(() => { const e = document.activeElement; try {
  if (e && typeof e.setSelectionRange === 'function' && typeof e.value === 'string') { const n = e.value.length; e.setSelectionRange(n, n); }
  else if (e && e.isContentEditable) { const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
} catch (error) {} })()`;

/** Sets a select, a date or a colour from the phone's native control, the way a person choosing it would (the page hears input and change). */
const setValueExpression = (value: string | string[]): string => `((value) => {
  const e = document.activeElement;
  if (!e) return false;
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
})(${JSON.stringify(value)})`;

type Message = { t?: string; [key: string]: unknown };

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
    cdp.on('Runtime.bindingCalled', (event: { name: string; payload: string }) => { if (event.name === '__clikFocus') void this.onFocus(event.payload); });
    cdp.on('Page.frameNavigated', (event: { frame: { parentId?: string; url: string } }) => { if (!event.frame.parentId) this.sendPage(event.frame.url); });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: '__clikFocus' });
    const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FOCUS_SCRIPT }) as { identifier: string };
    this.scriptId = added.identifier;
    await cdp.send('Runtime.evaluate', { expression: FOCUS_SCRIPT }).catch(quiet('agent/computer/handoff-live'));
    await this.page.bringToFront().catch(quiet('agent/computer/handoff-live'));
    this.sendPage(this.page.url());
    this.up = true;
    void this.drain();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.unstick);
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
    if (last && ((message.t === 'touch' && message.k === 'm' && last.t === 'touch' && last.k === 'm') || (message.t === 'mouse' && message.k === 'm' && last.t === 'mouse' && last.k === 'm') || (message.t === 'resize' && last.t === 'resize'))) this.queue[this.queue.length - 1] = message;
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
      }
    } finally { this.draining = false; }
  }

  private async handle(message: Message): Promise<void> {
    const cdp = this.cdp!;
    switch (message.t) {
      case 'hello': case 'resize': {
        const size = cleanSize(message);
        if (size) await this.layout(size);
        return;
      }
      case 'touch': {
        const points = cleanPoints(message.p);
        const type = ({ s: 'touchStart', m: 'touchMove', e: 'touchEnd', c: 'touchCancel' } as Record<string, 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel'>)[String(message.k)];
        if (!points || !type) return;
        await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(point => ({ x: point.x, y: point.y, id: point.id })) });
        return;
      }
      case 'mouse': {
        const x = Number(message.x), y = Number(message.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < -1 || y < -1 || x > 20_000 || y > 20_000) return;
        const button = BUTTONS[Number(message.b)] ?? 'left';
        const mask = { left: 1, middle: 4, right: 2 }[button];
        if (message.k === 'w') { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: Math.max(-2000, Math.min(2000, Number(message.dx) || 0)), deltaY: Math.max(-2000, Math.min(2000, Number(message.dy) || 0)) }); return; }
        const type = ({ d: 'mousePressed', u: 'mouseReleased', m: 'mouseMoved' } as Record<string, 'mousePressed' | 'mouseReleased' | 'mouseMoved'>)[String(message.k)];
        if (!type) return;
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !message.down ? 'none' : button, buttons: type === 'mouseReleased' ? 0 : (type === 'mousePressed' || message.down ? mask : 0), clickCount: type === 'mouseMoved' ? 0 : 1 });
        return;
      }
      case 'key': {
        const key = keyEvent(message.key);
        if (!key) return;
        const times = Math.max(1, Math.min(MAX_REPEAT, Math.floor(Number(message.n) || 1)));
        for (let i = 0; i < times; i++) {
          await cdp.send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk, ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}) });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk });
        }
        return;
      }
      case 'text': {
        if (typeof message.s === 'string' && message.s.length > 0 && message.s.length <= MAX_TEXT) await cdp.send('Input.insertText', { text: message.s });
        return;
      }
      case 'set': {
        const value = message.v;
        const ok = typeof value === 'string' ? value.length <= 2_000 : Array.isArray(value) && value.length <= 300 && value.every(item => typeof item === 'string' && item.length <= 2_000);
        if (ok) await cdp.send('Runtime.evaluate', { expression: setValueExpression(value as string | string[]) });
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

  private async onFocus(payload: string): Promise<void> {
    let descriptor: unknown;
    try { descriptor = JSON.parse(payload); } catch { return; }
    if (!descriptor) { this.send({ t: 'blur' }); return; }
    const kind = (descriptor as { kind?: string }).kind;
    if (kind === 'text') await this.cdp?.send('Runtime.evaluate', { expression: CARET_TO_END }).catch(quiet('agent/computer/handoff-live'));
    this.send({ t: 'focus', d: descriptor });
  }

  private async layout(size: Size): Promise<void> {
    const cdp = this.cdp!;
    const same = this.size && this.size.w === size.w && this.size.h === size.h && this.size.dpr === size.dpr;
    this.size = size;
    if (same && this.streaming) return;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: size.dpr, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    // Frames at the screen's own density up to 2x: a phone's 3x costs more to send than the eye can tell from 2x.
    const scale = Math.min(size.dpr, 2);
    if (this.streaming) await cdp.send('Page.stopScreencast').catch(quiet('agent/computer/handoff-live'));
    this.held = undefined;
    this.ready = true;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: Math.round(size.w * scale), maxHeight: Math.round(size.h * scale), everyNthFrame: 1 });
    this.streaming = true;
    this.stats.restarts++;
    this.send({ t: 'size', w: size.w, h: size.h });
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

  private async ackChrome(sessionId: number): Promise<void> {
    await this.cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  }
}

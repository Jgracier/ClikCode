/** The live view when it is for watching (the show action): the tab is left as the agent has it. No browser: Chrome's side is a recorder. */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { LiveView } from './handoff-live.js';
import { handoffPage } from './handoff-page.js';
import type { LiteSocket } from './ws-lite.js';

function rig(options: { watch?: boolean } = {}) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (event: unknown) => void>();
  let receive: (data: string | Buffer, binary: boolean) => void = () => undefined;
  let closed = false;
  const cdp = {
    on: (event: string, handler: (event: unknown) => void) => { handlers.set(event, handler); },
    send: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, ...(params ? { params } : {}) });
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' };
      if (method === 'Runtime.evaluate' && String(params?.['expression']).includes('innerWidth')) return { result: { value: { w: 1440, h: 900 } } };
      if (method === 'Runtime.evaluate' && String(params?.['expression']).includes('visualViewport.scale')) return { result: { value: { scale: 1, x: 0, y: 0 } } };
      return {};
    },
    detach: async () => undefined,
  };
  const page = { context: () => ({ newCDPSession: async () => cdp }), bringToFront: async () => undefined, url: () => 'https://example.com/a', mainFrame: () => ({}), frames: () => [] } as unknown as Page;
  const socket: LiteSocket = {
    send: data => { if (typeof data === 'string') sent.push(JSON.parse(data) as Record<string, unknown>); },
    close: () => { closed = true; }, buffered: 0, get closed() { return closed; },
    onMessage: handler => { receive = handler; }, onClose: () => undefined,
  };
  const view = new LiveView(page, socket, () => undefined, () => undefined, options);
  const say = async (message: Record<string, unknown>): Promise<void> => { receive(JSON.stringify(message), false); await new Promise(resolve => setTimeout(resolve, 20)); };
  const methods = (): string[] => calls.map(call => call.method);
  return { view, calls, sent, say, methods, frame: (metadata: Record<string, number>) => handlers.get('Page.screencastFrame')!({ data: '', sessionId: 1, metadata }) };
}

describe('a live view for watching', () => {
  it('leaves the tab at its own size and tells the viewer that size', async () => {
    const r = rig({ watch: true });
    await r.view.start();
    await r.say({ t: 'hello', w: 800, h: 600, dpr: 1, m: 'touch' });
    expect(r.methods()).toContain('Page.startScreencast');
    expect(r.methods()).not.toContain('Emulation.setDeviceMetricsOverride');
    expect(r.methods()).not.toContain('Emulation.setTouchEmulationEnabled');
    expect(r.calls.find(call => call.method === 'Page.startScreencast')!.params).toMatchObject({ maxWidth: 800, maxHeight: 600 });
    expect(r.sent).toContainEqual({ t: 'size', w: 1440, h: 900 });
    await r.view.stop();
    expect(r.methods()).toContain('Page.stopScreencast');
    expect(r.methods()).not.toContain('Emulation.clearDeviceMetricsOverride');
  });

  it('tells the viewer again when the tab changes size', async () => {
    const r = rig({ watch: true });
    await r.view.start();
    await r.say({ t: 'hello', w: 800, h: 600, dpr: 1 });
    const sizes = (): number => r.sent.filter(message => message['t'] === 'size').length;
    const before = sizes();
    r.frame({ deviceWidth: 1440, deviceHeight: 900 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sizes()).toBe(before + 1);
    r.frame({ deviceWidth: 1440, deviceHeight: 900 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sizes()).toBe(before + 1);
    r.frame({ deviceWidth: 390, deviceHeight: 844 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sizes()).toBe(before + 2);
    await r.view.stop();
  });

  it('takes a mouse and keys from the viewer, never a touch', async () => {
    const r = rig({ watch: true });
    await r.view.start();
    await r.say({ t: 'hello', w: 800, h: 600, dpr: 1 });
    await r.say({ t: 'touch', k: 's', p: [[0, 10, 10]] });
    expect(r.methods()).not.toContain('Input.dispatchTouchEvent');
    await r.say({ t: 'mouse', k: 'd', b: 0, x: 700, y: 450 });
    expect(r.calls.find(call => call.method === 'Input.dispatchMouseEvent')!.params).toMatchObject({ type: 'mousePressed', x: 700, y: 450, button: 'left' });
    await r.say({ t: 'text', s: 'k' });
    expect(r.calls.filter(call => call.method === 'Input.dispatchKeyEvent').map(call => call.params)).toEqual([{ type: 'keyDown', key: 'k', text: 'k', unmodifiedText: 'k' }, { type: 'keyUp', key: 'k' }]);
    const keys = r.calls.length;
    for (const bad of ['', 'two', 7, undefined]) await r.say({ t: 'text', s: bad as never });
    expect(r.calls.slice(keys).filter(call => call.method === 'Input.dispatchKeyEvent')).toEqual([]);
    await r.view.stop();
  });
});

describe('a live view for a handoff', () => {
  it('still lays the tab out for the device that opened it, and puts it back after', async () => {
    const r = rig();
    await r.view.start();
    await r.say({ t: 'hello', w: 390, h: 760, dpr: 3, m: 'touch' });
    expect(r.calls.find(call => call.method === 'Emulation.setDeviceMetricsOverride')!.params).toEqual({ width: 390, height: 760, deviceScaleFactor: 3, mobile: true });
    expect(r.sent).toContainEqual({ t: 'size', w: 390, h: 760 });
    await r.view.stop();
    expect(r.methods()).toContain('Emulation.clearDeviceMetricsOverride');
  });
});

describe('the page of a live view', () => {
  const script = (html: string): string => /<script>([\s\S]*)<\/script>/.exec(html)![1]!;

  it('is one script that parses, for a handoff and for watching', () => {
    for (const html of [handoffPage(), handoffPage({ watch: true }), handoffPage({ back: '/abc/' })]) expect(() => new Function(script(html))).not.toThrow();
  });

  it('has Done and the touch switch for a handoff, and neither for watching', () => {
    const handoff = handoffPage(), watching = handoffPage({ watch: true });
    expect(handoff).toContain('<button id="done">Done</button>');
    expect(handoff).toContain('id="mode"');
    expect(handoff).toContain('const WATCH = false;');
    expect(watching).not.toContain('id="done"');
    expect(watching).not.toContain('id="mode"');
    expect(watching).toContain('const WATCH = true;');
    expect(watching).toContain('your clicks and typing reach the page too');
    // Nothing from anywhere else, in either.
    for (const html of [handoff, watching]) expect(html).not.toMatch(/(?:src|href)="https?:/);
  });
});

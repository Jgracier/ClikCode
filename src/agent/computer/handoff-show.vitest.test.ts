import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { openOnDesktop, SHOW_NO_TAB_MS, showTab, tendShow, type ShowDeps } from './handoff-show.js';
import type { LiveServer } from './handoff-serve.js';

/** A chat with one tab, a desktop, a hidden browser, and a record of what was served and opened. */
function world(change: Partial<ShowDeps> = {}) {
  const made: Array<{ host: string; watch?: boolean; ownHostOnly?: boolean }> = [];
  const opened: Array<{ url: string; session: Record<string, string> }> = [];
  const state = { front: 0, stopped: 0, reconnects: 0, clock: 1_000, viewing: undefined as Page | undefined, tab: undefined as Page | undefined };
  const tab = (): Page => ({ isClosed: () => false, bringToFront: async () => { state.front++; } }) as unknown as Page;
  state.tab = tab();
  const deps: Partial<ShowDeps> = {
    page: async () => { if (!state.tab) throw new Error('This chat has no open tab. Open a URL with browser_use first.'); return state.tab; },
    current: () => state.tab,
    inCloud: () => false,
    hostDisplay: async () => 'hidden',
    session: () => ({}),
    remote: () => false,
    serve: async input => {
      made.push({ host: input.host, ...(input.watch !== undefined ? { watch: input.watch } : {}), ...(input.ownHostOnly !== undefined ? { ownHostOnly: input.ownHostOnly } : {}) });
      const server: LiveServer = { address: `http://127.0.0.1:5${made.length}000/token-${made.length}/`, viewing: () => state.viewing, reconnect: () => { state.reconnects++; }, end: () => undefined, stop: async () => { state.stopped++; } };
      return server;
    },
    open: async (url, session) => { opened.push({ url, session }); return true; },
    now: () => state.clock,
    mark: () => undefined,
    ...change,
  };
  return { deps, made, opened, state, tab };
}

let dirs = 0;
const chat = (): string => `/tmp/clikcode-show-test-${process.pid}-${dirs++}`;
const open: Array<{ stateDir: string; tab?: string }> = [];
afterEach(async () => { for (const input of open.splice(0)) await showTab({ ...input, clear: true }); });
const show = (input: { stateDir: string; tab?: string; clear?: boolean; limitMs?: number }, deps: Partial<ShowDeps>): Promise<string> => { open.push({ stateDir: input.stateDir, ...(input.tab ? { tab: input.tab } : {}) }); return showTab(input, deps); };

describe('show', () => {
  it('serves a watching view on this computer only and opens it in the user\'s browser', async () => {
    const w = world({ session: () => ({ WAYLAND_DISPLAY: 'wayland-0' }) });
    const text = await show({ stateDir: chat() }, w.deps);
    expect(w.made).toEqual([{ host: '127.0.0.1', watch: true, ownHostOnly: true }]);
    expect(w.opened).toEqual([{ url: 'http://127.0.0.1:51000/token-1/', session: { WAYLAND_DISPLAY: 'wayland-0' } }]);
    expect(text).toMatch(/^Opened a live view of this tab in the user's default browser on their desktop: http:\/\/127\.0\.0\.1:51000\/token-1\/\n/);
    expect(text).toContain('keep acting on the tab as usual');
    expect(text).toContain('clikcode computer display visible');
    expect(w.state.front).toBe(0);
  });

  it('gives the same address when asked again, and opens it again only when nobody is looking', async () => {
    const w = world();
    const stateDir = chat();
    await show({ stateDir }, w.deps);
    const again = await show({ stateDir }, w.deps);
    expect(w.made).toHaveLength(1);
    expect(w.opened.map(item => item.url)).toEqual(['http://127.0.0.1:51000/token-1/', 'http://127.0.0.1:51000/token-1/']);
    expect(again).toMatch(/^Opened the live view again, at the same address: http:\/\/127\.0\.0\.1:51000\/token-1\//);
    w.state.viewing = w.state.tab;
    const watched = await show({ stateDir }, w.deps);
    expect(w.opened).toHaveLength(2);
    expect(watched).toContain('already has the live view of this tab open (http://127.0.0.1:51000/token-1/)');
  });

  it('keeps one view per named tab', async () => {
    const w = world();
    const stateDir = chat();
    await show({ stateDir }, w.deps);
    const other = await show({ stateDir, tab: 'docs' }, w.deps);
    expect(w.made).toHaveLength(2);
    expect(other).toContain('token-2');
  });

  it('closes with clear, and says when there was nothing to close', async () => {
    const w = world();
    const stateDir = chat();
    expect(await showTab({ stateDir, clear: true }, w.deps)).toBe('No live view is open on this tab.');
    await show({ stateDir }, w.deps);
    expect(await showTab({ stateDir, clear: true }, w.deps)).toBe('The live view is closed. The tab is unchanged.');
    expect(w.state.stopped).toBe(1);
    // A new one after that is a new address.
    expect(await show({ stateDir }, w.deps)).toContain('token-2');
  });

  it('says plainly that nothing was opened when there is no desktop, and still gives the address', async () => {
    const w = world({ session: () => undefined });
    const text = await show({ stateDir: chat() }, w.deps);
    expect(w.opened).toEqual([]);
    expect(text).toMatch(/^NOT OPENED\. No desktop session was found/);
    expect(text).toContain('http://127.0.0.1:51000/token-1/');
    expect(text).toContain('use handoff');
  });

  it('does not open a window on a desktop the user is not at (ssh)', async () => {
    const w = world({ remote: () => true, hostDisplay: async () => 'visible' });
    const text = await show({ stateDir: chat() }, w.deps);
    expect(w.opened).toEqual([]);
    expect(w.state.front).toBe(0);
    expect(text).toMatch(/^NOT OPENED\. This chat is being driven from a remote session/);
    expect(text).toContain('http://127.0.0.1:51000/token-1/');
  });

  it('never says opened when the opener failed', async () => {
    const w = world({ open: async () => false });
    const text = await show({ stateDir: chat() }, w.deps);
    expect(text).toMatch(/^NOT OPENED\. The desktop's browser opener/);
    expect(text).toContain('http://127.0.0.1:51000/token-1/');
    expect(text).not.toMatch(/^Opened/);
  });

  it('brings the tab to the front instead when the browser window is already on the desktop', async () => {
    const w = world({ hostDisplay: async () => 'visible' });
    const text = await show({ stateDir: chat() }, w.deps);
    expect(w.made).toEqual([]);
    expect(w.opened).toEqual([]);
    expect(w.state.front).toBe(1);
    expect(text).toContain('this tab is now in front');
    // A cloud tab is in no local window: it gets the live view.
    const cloud = world({ hostDisplay: async () => 'visible', inCloud: () => true });
    await show({ stateDir: chat() }, cloud.deps);
    expect(cloud.made).toHaveLength(1);
  });

  it('needs a tab to show', async () => {
    const w = world();
    w.state.tab = undefined;
    await expect(show({ stateDir: chat() }, w.deps)).rejects.toThrow('no open tab');
    expect(w.made).toEqual([]);
  });

  it('moves a viewer to the tab the chat is in now, and ends once the chat has had no tab for ten minutes', async () => {
    const w = world();
    const stateDir = chat();
    await show({ stateDir }, w.deps);
    const deps = { current: () => w.state.tab, now: () => w.state.clock };
    w.state.viewing = w.state.tab;
    await tendShow(stateDir, deps);
    expect(w.state.reconnects).toBe(0);
    w.state.tab = w.tab();
    await tendShow(stateDir, deps);
    expect(w.state.reconnects).toBe(1);
    // The tab closes: the view waits, and a tab opened in time keeps it.
    w.state.tab = undefined;
    await tendShow(stateDir, deps);
    w.state.clock += SHOW_NO_TAB_MS - 1;
    await tendShow(stateDir, deps);
    expect(w.state.stopped).toBe(0);
    w.state.tab = w.tab();
    await tendShow(stateDir, deps);
    w.state.tab = undefined;
    w.state.clock += SHOW_NO_TAB_MS;
    await tendShow(stateDir, deps);
    expect(w.state.stopped).toBe(0);
    w.state.clock += SHOW_NO_TAB_MS;
    await tendShow(stateDir, deps);
    expect(w.state.stopped).toBe(1);
    expect(await showTab({ stateDir, clear: true }, w.deps)).toBe('No live view is open on this tab.');
  });
});

describe('opening the user\'s browser', () => {
  const fake = (after: (child: EventEmitter) => void) => {
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const start = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env });
      const child = Object.assign(new EventEmitter(), { unref: () => undefined });
      setTimeout(() => after(child), 5);
      return child;
    }) as never;
    return { calls, start };
  };

  it('uses the desktop\'s own opener, on the desktop that was found', async () => {
    const linux = fake(child => child.emit('exit', 0));
    expect(await openOnDesktop('http://127.0.0.1:1/t/', { WAYLAND_DISPLAY: 'wayland-0' }, { platform: 'linux', env: { PATH: '/usr/bin', DISPLAY: ':99', ELECTRON_RUN_AS_NODE: '1' }, start: linux.start })).toBe(true);
    expect(linux.calls).toEqual([{ command: 'xdg-open', args: ['http://127.0.0.1:1/t/'], env: { PATH: '/usr/bin', DISPLAY: ':99', WAYLAND_DISPLAY: 'wayland-0' } }]);
    const mac = fake(child => child.emit('exit', 0));
    await openOnDesktop('http://127.0.0.1:1/t/', {}, { platform: 'darwin', env: {}, start: mac.start });
    expect(mac.calls[0]).toMatchObject({ command: 'open', args: ['http://127.0.0.1:1/t/'] });
    const windows = fake(child => child.emit('exit', 0));
    await openOnDesktop('http://127.0.0.1:1/t/', {}, { platform: 'win32', env: {}, start: windows.start });
    expect(windows.calls[0]).toMatchObject({ command: 'cmd', args: ['/c', 'start', '', 'http://127.0.0.1:1/t/'] });
  });

  it('is opened only when the opener started and did not fail', async () => {
    const url = 'http://127.0.0.1:1/t/';
    expect(await openOnDesktop(url, {}, { platform: 'linux', env: {}, start: fake(child => child.emit('error', new Error('spawn xdg-open ENOENT'))).start })).toBe(false);
    // xdg-open's own failures: 3 is no handler, 4 is the action failed.
    expect(await openOnDesktop(url, {}, { platform: 'linux', env: {}, start: fake(child => child.emit('exit', 3)).start })).toBe(false);
    expect(await openOnDesktop(url, {}, { platform: 'linux', env: {}, start: fake(child => child.emit('exit', null)).start })).toBe(false);
    expect(await openOnDesktop(url, {}, { platform: 'linux', env: {}, start: (() => { throw new Error('EACCES'); }) as never })).toBe(false);
    // An opener that became the browser is still running: that is open.
    expect(await openOnDesktop(url, {}, { platform: 'linux', env: {}, start: fake(() => undefined).start, settleMs: 30 })).toBe(true);
  });
});

describe('show never hangs', () => {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  for (const [step, change, says] of [
    ['page', { page: never }, 'did not hand over this chat\'s tab in time'],
    ['serve', { serve: never }, 'live view could not be started in time'],
    ['open', { open: never }, 'opener did not answer in time'],
  ] as const) {
    it(`answers within its limit when ${step} never does`, async () => {
      const w = world(change as Partial<ShowDeps>);
      const started = Date.now();
      const text = await show({ stateDir: chat(), limitMs: 200 }, w.deps);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(text).toMatch(/^NOT OPENED: /);
      expect(text).toContain(says);
      if (step === 'open') expect(text).toContain('http://127.0.0.1:51000/token-1/');
    });
  }

  it('stops a server that comes up after the limit', async () => {
    let up!: (server: LiveServer) => void;
    let stopped = 0;
    const w = world({ serve: () => new Promise<LiveServer>(resolve => { up = resolve; }) });
    const stateDir = chat();
    expect(await show({ stateDir, limitMs: 50 }, w.deps)).toMatch(/^NOT OPENED: /);
    up({ address: 'http://127.0.0.1:1/late/', viewing: () => undefined, reconnect: () => undefined, end: () => undefined, stop: async () => { stopped++; } });
    await new Promise(resolve => setImmediate(resolve));
    expect(stopped).toBe(1);
    // Nothing half-made was kept: the next show serves anew.
    expect(await showTab({ stateDir, clear: true }, w.deps)).toBe('No live view is open on this tab.');
  });
});


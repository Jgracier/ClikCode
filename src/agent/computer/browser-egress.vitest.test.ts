/** A tab bound to an egress opens its pages in that egress's context: the one the browser host owns (the page is made with
 * Target.createTarget in it and picked up by target id), or -- only when no host of this build serves egress -- one this worker makes
 * with the egress proxy. An unbound tab stays in the shared profile's context, as always. Fakes stand in for Chrome and the host. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type FakePage = { closed: boolean; ctx: FakeContext; targetId: string; inContext?: string; isClosed(): boolean; url(): string; close(): Promise<void>; on(): void; once(): void; off(): void; context(): FakeContext; evaluate(): Promise<unknown> };
type FakeContext = { name: string; proxy?: string; closed: boolean; pages(): FakePage[]; newPage(): Promise<FakePage>; add(inContext?: string): FakePage; newCDPSession(page: FakePage): Promise<{ send(method: string): Promise<unknown>; detach(): Promise<void> }>; on(event: string, listener: (value?: unknown) => void): void; off(event: string, listener: (value?: unknown) => void): void; close(): Promise<void> };

let targets = 0;
function makeContext(name: string, proxy?: string): FakeContext {
  const pages: FakePage[] = [];
  const listeners = new Map<string, Array<(value?: unknown) => void>>();
  const context: FakeContext = {
    name, ...(proxy ? { proxy } : {}), closed: false,
    pages: () => pages.filter(page => !page.closed),
    add: inContext => {
      const page: FakePage = { closed: false, ctx: context, targetId: `target-${++targets}`, ...(inContext ? { inContext } : {}), isClosed: () => page.closed, url: () => 'about:blank', close: async () => { page.closed = true; }, on: () => undefined, once: () => undefined, off: () => undefined, context: () => context, evaluate: async () => undefined };
      pages.push(page);
      return page;
    },
    newPage: async () => context.add(),
    newCDPSession: async page => ({ send: async (method: string) => (method === 'Target.getTargetInfo' ? { targetInfo: { targetId: page.targetId } } : {}), detach: async () => undefined }),
    on: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
    off: (event, listener) => { listeners.set(event, (listeners.get(event) ?? []).filter(l => l !== listener)); },
    close: async () => { context.closed = true; (listeners.get('close') ?? []).forEach(run => run()); },
  };
  (context as unknown as { emit(event: string, value: unknown): void }).emit = (event, value) => (listeners.get(event) ?? []).forEach(run => run(value));
  return context;
}

const servers = new Map<string, string | undefined>();
const egressServer = vi.fn(async (_dir: string, name: string) => servers.get(name));
vi.mock('./egress.js', async importOriginal => ({ ...(await importOriginal<typeof import('./egress.js')>()), egressServer: (dir: string, name: string) => egressServer(dir, name) }));
let hostServes = false;
const hosted = vi.fn(async (_dir: string, name: string) => ({ id: `host-ctx-${name}`, server: servers.get(name)! }));
vi.mock('./egress-host.js', async importOriginal => {
  const real = await importOriginal<typeof import('./egress-host.js')>();
  return { ...real, requestHostedContext: async (dir: string, name: string) => { if (!hostServes) throw new real.EgressNotServed('no host'); return hosted(dir, name); } };
});

const { bindTabEgress, closeComputerPage, egressOfPage, openComputerPage, openNewComputerPage, tabEgress } = await import('./browser.js');

let dir: string;
let home: FakeContext;
let made: FakeContext[];
let created: Array<{ url: string; browserContextId: string }>;
const runningMap = (): Map<string, Promise<unknown>> => (globalThis as unknown as Record<string, Map<string, Promise<unknown>>>)['__clikcode_browser-running']!;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-egress-tabs-'));
  await fs.mkdir(path.join(dir, 'computer'), { recursive: true });
  home = makeContext('home');
  made = []; created = [];
  const browser = {
    on: () => undefined, close: async () => undefined,
    newContext: vi.fn(async (options: { proxy: { server: string } }) => { const context = makeContext(`egress-${made.length}`, options.proxy.server); made.push(context); return context; }),
    // Chrome makes the target in the host's context; this connection's Playwright files it under the default context.
    newBrowserCDPSession: async () => ({
      send: async (method: string, params: { url: string; browserContextId: string }) => {
        if (method !== 'Target.createTarget') return {};
        created.push(params);
        const page = home.add(params.browserContextId);
        setTimeout(() => (home as unknown as { emit(e: string, v: unknown): void }).emit('page', page), 5);
        return { targetId: page.targetId };
      },
      detach: async () => undefined,
    }),
  };
  runningMap().set(dir, Promise.resolve({ browser, context: home }));
  servers.clear(); servers.set('home', undefined); servers.set('prod', 'socks5://127.0.0.1:41000'); servers.set('phone', 'http://100.64.0.9:8080');
  egressServer.mockClear(); hosted.mockClear(); hostServes = false;
});
afterEach(async () => {
  runningMap().delete(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('a tab bound to an egress, with the browser host serving egress', () => {
  beforeEach(() => { hostServes = true; });

  it('opens its pages in the host\'s context for that egress, found by target id, and never makes a context itself', async () => {
    await bindTabEgress(dir, 'loop-a', 'prod');
    await bindTabEgress(dir, 'agent-a', 'prod');
    const a = await openComputerPage(dir, 'loop-a') as unknown as FakePage;
    const agent = await openNewComputerPage(dir, 'agent-a') as unknown as FakePage;
    expect(a.inContext).toBe('host-ctx-prod');
    expect(agent.inContext).toBe('host-ctx-prod');
    expect(created).toEqual([{ url: 'about:blank', browserContextId: 'host-ctx-prod' }, { url: 'about:blank', browserContextId: 'host-ctx-prod' }]);
    expect(made).toHaveLength(0);
    expect(egressOfPage(a as never)).toBe('prod');
    expect(await openComputerPage(dir, 'loop-a')).toBe(a);
  });

  it('a host failure (a tunnel that would not open) fails the page open instead of leaving from home', async () => {
    hosted.mockRejectedValueOnce(new Error('The ssh tunnel to prod-host ended before it was ready.'));
    await bindTabEgress(dir, 'loop-a', 'prod');
    await expect(openComputerPage(dir, 'loop-a')).rejects.toThrow(/ended before it was ready/);
    expect(home.pages()).toHaveLength(0);
  });

  it('an unbound tab opens in the shared profile and asks the host nothing', async () => {
    const page = await openComputerPage(dir, 'plain') as unknown as FakePage;
    expect(page.ctx).toBe(home);
    expect(page.inContext).toBeUndefined();
    expect(egressOfPage(page as never)).toBeUndefined();
    expect(hosted).not.toHaveBeenCalled();
    expect(egressServer).not.toHaveBeenCalled();
  });
});

describe('a tab bound to an egress, with no host serving egress (an older host)', () => {
  it('opens in a context this worker makes with the egress proxy, one per egress per connection, reused', async () => {
    await bindTabEgress(dir, 'loop-a', 'prod');
    await bindTabEgress(dir, 'loop-b', 'prod');
    await bindTabEgress(dir, 'loop-c', 'phone');
    const a = await openComputerPage(dir, 'loop-a') as unknown as FakePage;
    const a2 = await openNewComputerPage(dir, 'loop-a') as unknown as FakePage;
    const b = await openComputerPage(dir, 'loop-b') as unknown as FakePage;
    const c = await openComputerPage(dir, 'loop-c') as unknown as FakePage;
    expect(made.map(context => context.proxy)).toEqual(['socks5://127.0.0.1:41000', 'http://100.64.0.9:8080']);
    expect(a.ctx).toBe(made[0]); expect(a2.ctx).toBe(made[0]); expect(b.ctx).toBe(made[0]); expect(c.ctx).toBe(made[1]);
    expect(egressOfPage(a as never)).toBe('prod');
    expect(egressOfPage(c as never)).toBe('phone');
    expect(tabEgress(dir, 'loop-a')).toBe('prod');
    expect(await openComputerPage(dir, 'loop-a')).toBe(a2);
  });

  it('a new context is made when the egress proxy changed (a tunnel started again on a new port)', async () => {
    await bindTabEgress(dir, 'loop-a', 'prod');
    await openComputerPage(dir, 'loop-a');
    servers.set('prod', 'socks5://127.0.0.1:42000');
    const again = await openNewComputerPage(dir, 'loop-a') as unknown as FakePage;
    expect(made.map(context => context.proxy)).toEqual(['socks5://127.0.0.1:41000', 'socks5://127.0.0.1:42000']);
    expect(again.ctx).toBe(made[1]);
    expect(made[0]!.closed).toBe(true);
  });
});

describe('binding', () => {
  it('to another egress (or home) closes the tab\'s pages in the old one; home is no binding', async () => {
    hostServes = true;
    await bindTabEgress(dir, 'loop-a', 'prod');
    const old = await openComputerPage(dir, 'loop-a') as unknown as FakePage;
    await bindTabEgress(dir, 'loop-a', 'home');
    expect(old.closed).toBe(true);
    expect(tabEgress(dir, 'loop-a')).toBeUndefined();
    const fresh = await openComputerPage(dir, 'loop-a') as unknown as FakePage;
    expect(fresh.inContext).toBeUndefined();
    expect(egressOfPage(fresh as never)).toBeUndefined();
    await closeComputerPage(dir, 'loop-a');
  });
});

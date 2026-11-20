/** A tab bound to an egress opens its pages in a context of its own made over the same Chrome connection with that egress's proxy; an
 * unbound tab stays in the shared profile's context, as always. Fakes stand in for Chrome. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type FakeContext = { name: string; proxy?: string; pages(): FakePage[]; newPage(): Promise<FakePage>; newCDPSession(): Promise<never>; on(event: string, listener: () => void): void; close(): Promise<void>; closed: boolean; listeners: Array<() => void> };
type FakePage = { closed: boolean; ctx: FakeContext; isClosed(): boolean; url(): string; close(): Promise<void>; on(): void; once(): void; off(): void; context(): FakeContext; evaluate(): Promise<unknown> };

function makeContext(name: string, proxy?: string): FakeContext {
  const pages: FakePage[] = [];
  const context: FakeContext = {
    name, ...(proxy ? { proxy } : {}), closed: false, listeners: [],
    pages: () => pages.filter(page => !page.closed),
    newPage: async () => { const page: FakePage = { closed: false, ctx: context, isClosed: () => page.closed, url: () => 'about:blank', close: async () => { page.closed = true; }, on: () => undefined, once: () => undefined, off: () => undefined, context: () => context, evaluate: async () => undefined }; pages.push(page); return page; },
    newCDPSession: async () => { throw new Error('no cdp in the fake'); },
    on: (event, listener) => { if (event === 'close') context.listeners.push(listener); },
    close: async () => { context.closed = true; context.listeners.forEach(run => run()); },
  };
  return context;
}

const servers = new Map<string, string | undefined>();
const egressServer = vi.fn(async (_dir: string, name: string) => servers.get(name));
vi.mock('./egress.js', async importOriginal => ({ ...(await importOriginal<typeof import('./egress.js')>()), egressServer: (dir: string, name: string) => egressServer(dir, name) }));

const { bindTabEgress, closeComputerPage, egressOfPage, openComputerPage, openNewComputerPage, tabEgress } = await import('./browser.js');

let dir: string;
let home: FakeContext;
let made: FakeContext[];
const running = (globalThis as unknown as Record<string, Map<string, Promise<unknown>>>)['__clikcode_browser-running'] ?? new Map();
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-egress-tabs-'));
  await fs.mkdir(path.join(dir, 'computer'), { recursive: true });
  home = makeContext('home');
  made = [];
  const browser = { on: () => undefined, close: async () => undefined, newContext: vi.fn(async (options: { proxy: { server: string } }) => { const context = makeContext(`egress-${made.length}`, options.proxy.server); made.push(context); return context; }) };
  (globalThis as unknown as Record<string, unknown>)['__clikcode_browser-running'] ??= running;
  ((globalThis as unknown as Record<string, Map<string, Promise<unknown>>>)['__clikcode_browser-running']!).set(dir, Promise.resolve({ browser, context: home }));
  servers.clear(); servers.set('home', undefined); servers.set('prod', 'socks5://127.0.0.1:41000'); servers.set('phone', 'http://100.64.0.9:8080');
  egressServer.mockClear();
});
afterEach(async () => {
  ((globalThis as unknown as Record<string, Map<string, Promise<unknown>>>)['__clikcode_browser-running']!).delete(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('a tab bound to an egress', () => {
  it('an unbound tab opens in the shared profile, and never asks for an egress', async () => {
    const page = await openComputerPage(dir, 'plain') as unknown as FakePage;
    expect(page.ctx).toBe(home);
    expect(egressOfPage(page as never)).toBeUndefined();
    expect(egressServer).not.toHaveBeenCalled();
    expect(made).toHaveLength(0);
  });

  it('opens in a context with the egress proxy, one per egress per connection, reused', async () => {
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
    // The tab's own page is found again, not a new one.
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

  it('binding a tab to another egress (or home) closes its pages in the old one; home is no binding', async () => {
    await bindTabEgress(dir, 'loop-a', 'prod');
    const old = await openComputerPage(dir, 'loop-a') as unknown as FakePage;
    await bindTabEgress(dir, 'loop-a', 'home');
    expect(old.closed).toBe(true);
    expect(tabEgress(dir, 'loop-a')).toBeUndefined();
    const fresh = await openComputerPage(dir, 'loop-a') as unknown as FakePage;
    expect(fresh.ctx).toBe(home);
    await closeComputerPage(dir, 'loop-a');
  });

  it('an egress that cannot be opened fails the page open, and the next call tries again', async () => {
    egressServer.mockRejectedValueOnce(new Error('The ssh tunnel to prod-host ended before it was ready.'));
    await bindTabEgress(dir, 'loop-a', 'prod');
    await expect(openComputerPage(dir, 'loop-a')).rejects.toThrow(/ended before it was ready/);
    expect((await openComputerPage(dir, 'loop-a') as unknown as FakePage).ctx).toBe(made[0]);
  });
});

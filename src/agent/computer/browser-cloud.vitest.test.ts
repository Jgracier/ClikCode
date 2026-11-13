/** Local first: a tab moves to the managed cloud browser only when asked, and the billed session stops with its last tab. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type FakePage = { address: string; closed: boolean; isClosed(): boolean; url(): string; goto(url: string): Promise<void>; close(): Promise<void>; on(): void; once(): void; off(): void; context(): unknown; bringToFront(): Promise<void> };
const cloud = { pages: [] as FakePage[], closedBrowser: 0 };
const context = {
  pages: () => cloud.pages.filter(page => !page.closed),
  newPage: async () => makePage('about:blank'),
  newCDPSession: async () => { throw new Error('no cdp in the fake'); },
};
function makePage(address: string): FakePage {
  const page: FakePage = {
    address, closed: false, isClosed: () => page.closed, url: () => page.address,
    goto: async (url: string) => { page.address = url; }, close: async () => { page.closed = true; },
    on: () => undefined, once: () => undefined, off: () => undefined, context: () => context, bringToFront: async () => undefined,
  };
  cloud.pages.push(page);
  return page;
}
const browserUseConnection = vi.fn(async (_dir: string, start: boolean) => (start ? { browser: { on: () => undefined, close: async () => { cloud.closedBrowser++; } }, context } : undefined));
const stopBrowserUse = vi.fn(async () => true);
vi.mock('./browser-use-cloud.js', () => ({ browserUseConnection: (dir: string, start: boolean) => browserUseConnection(dir, start), stopBrowserUse: () => stopBrowserUse() }));

const { closeAllOwnedPages, closeComputerPage, cloudIdleMs, moveTabToCloud, moveTabToLocal, openComputerPage, privateAddress, releaseComputerBrowser, stopCloudBrowser, tabIsInCloud } = await import('./browser.js');
const { browserProvider, setBrowserProvider } = await import('./settings.js');

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-cloud-tabs-'));
  await fs.mkdir(path.join(dir, 'computer'), { recursive: true });
  cloud.pages = []; cloud.closedBrowser = 0;
  browserUseConnection.mockClear(); stopBrowserUse.mockClear();
});
afterEach(async () => { await stopCloudBrowser(dir).catch(() => undefined); await fs.rm(dir, { recursive: true, force: true }); });

describe('which browser a tab runs in', () => {
  it('is local unless the user chose otherwise', async () => {
    expect(await browserProvider(dir)).toBe('local');
    await setBrowserProvider(dir, 'auto');
    expect(await browserProvider(dir)).toBe('auto');
    await fs.writeFile(path.join(dir, 'computer', 'settings.json'), JSON.stringify({ browserProvider: 'something-else' }));
    expect(await browserProvider(dir)).toBe('local');
  });

  it('never starts a cloud session while the cloud browser is off', async () => {
    await expect(moveTabToCloud(dir, 'a')).rejects.toThrow(/browser-use auto/);
    expect(browserUseConnection).not.toHaveBeenCalled();
  });

  it('moves a tab to the cloud when asked, and later calls for that tab stay there', async () => {
    await setBrowserProvider(dir, 'auto');
    const { page, moved } = await moveTabToCloud(dir, 'a');
    expect(moved).toBe(true);
    expect(tabIsInCloud(dir, 'a')).toBe(true);
    expect(await openComputerPage(dir, 'a')).toBe(page);
    expect((await moveTabToCloud(dir, 'a')).moved).toBe(false);
    expect(browserUseConnection).toHaveBeenCalledTimes(1);
  });

  it('stops the billed session when its last tab closes', async () => {
    await setBrowserProvider(dir, 'auto');
    await moveTabToCloud(dir, 'a');
    await moveTabToCloud(dir, 'b');
    for (const page of cloud.pages) page.address = 'https://example.com/';
    await closeComputerPage(dir, 'a');
    expect(stopBrowserUse).not.toHaveBeenCalled();
    await closeComputerPage(dir, 'b');
    expect(stopBrowserUse).toHaveBeenCalledTimes(1);
    expect(tabIsInCloud(dir, 'b')).toBe(false);
  });

  it('leaves the session running while another worker still has a page open in it', async () => {
    await setBrowserProvider(dir, 'auto');
    await moveTabToCloud(dir, 'a');
    makePage('https://other-worker.example/');
    await closeComputerPage(dir, 'a');
    expect(stopBrowserUse).not.toHaveBeenCalled();
  });

  it('stops the session when the worker ends or a command lets go of the browser', async () => {
    await setBrowserProvider(dir, 'auto');
    await moveTabToCloud(dir, 'a');
    await closeAllOwnedPages(dir);
    expect(stopBrowserUse).toHaveBeenCalledTimes(1);
    await moveTabToCloud(dir, 'c');
    await releaseComputerBrowser(dir);
    expect(stopBrowserUse).toHaveBeenCalledTimes(2);
  });

  it('refuses to bring a tab back while the cloud runs every tab', async () => {
    await setBrowserProvider(dir, 'browser-use');
    const page = await openComputerPage(dir, 'a');
    expect(tabIsInCloud(dir, 'a')).toBe(true);
    expect(cloud.pages).toContain(page);
    await expect(moveTabToLocal(dir, 'a')).rejects.toThrow(/every tab/);
  });

  it('keeps addresses of this computer and its private network out of the cloud', () => {
    for (const address of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://192.168.1.4/x', 'http://10.0.0.2/', 'http://172.20.1.1/', 'http://100.70.212.126:8080/', 'http://box.local/', 'http://ser8.tail1234.ts.net/', 'http://[::1]/', 'http://intranet/', 'not a url']) expect(privateAddress(address), address).toBe(true);
    for (const address of ['https://example.com/', 'https://172.15.0.1/', 'https://100.63.0.1/', 'https://8.8.8.8/']) expect(privateAddress(address), address).toBe(false);
  });

  it('stops an idle session after ten minutes unless told otherwise, and never past the service\'s own hour', () => {
    expect(cloudIdleMs({})).toBe(600_000);
    expect(cloudIdleMs({ CLIKCODE_CLOUD_BROWSER_IDLE_MINUTES: '3' })).toBe(180_000);
    expect(cloudIdleMs({ CLIKCODE_CLOUD_BROWSER_IDLE_MINUTES: '500' })).toBe(55 * 60_000);
    expect(cloudIdleMs({ CLIKCODE_CLOUD_BROWSER_IDLE_MINUTES: 'soon' })).toBe(600_000);
  });
});

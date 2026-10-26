import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, BrowserType } from 'playwright-core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { hiddenDisplayCommand } from './browser.js';
import { installMarkerFile, launchComputerBrowser, NoBrowserError, noBrowserMessage, progressLine, readHostStatus, shouldRunHeadless } from './browser-launch.js';
import { computerSettingsPath, headlessSetting, setHeadless } from './settings.js';

let dir = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-launch-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('runs headless when forced, set, or when a Linux computer has no display', () => {
  expect(shouldRunHeadless({ env: { CLIKCODE_BROWSER_HEADLESS: '1' }, platform: 'darwin' })).toBe(true);
  expect(shouldRunHeadless({ env: { CLIKCODE_BROWSER_HEADLESS: 'true' }, platform: 'win32' })).toBe(true);
  expect(shouldRunHeadless({ env: { CLIKCODE_BROWSER_HEADLESS: '0' }, platform: 'linux', setting: true })).toBe(false);
  expect(shouldRunHeadless({ env: {}, platform: 'win32', setting: true })).toBe(true);
  expect(shouldRunHeadless({ env: {}, platform: 'linux' })).toBe(true);
  expect(shouldRunHeadless({ env: { DISPLAY: ':0' }, platform: 'linux' })).toBe(false);
  expect(shouldRunHeadless({ env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' })).toBe(false);
  // macOS and Windows always have a display: no change unless asked.
  expect(shouldRunHeadless({ env: {}, platform: 'darwin' })).toBe(false);
  expect(shouldRunHeadless({ env: {}, platform: 'win32' })).toBe(false);
});

it('does not wrap a headless browser in a virtual display', () => {
  expect(hiddenDisplayCommand(['node', 'x'], { CLIKCODE_BROWSER_HEADLESS: '1' }, 'linux', () => true)).toEqual(['node', 'x']);
  expect(hiddenDisplayCommand(['node', 'x'], {}, 'linux', () => true)[0]).toBe('xvfb-run');
});

it('keeps the headless setting in the account settings', async () => {
  expect(await headlessSetting(dir)).toBe(false);
  await setHeadless(dir, true);
  expect(await headlessSetting(dir)).toBe(true);
  expect(computerSettingsPath(dir)).toContain('settings.json');
});

it('shows the newest line of a download', () => {
  expect(progressLine('Downloading Chromium 141.0.7390.37 (playwright build v1194) from https://cdn\n|■■■■        |  40% of 150.2 MiB\r|■■■■■■      |  60% of 150.2 MiB')).toBe('60% of 150.2 MiB');
  expect(progressLine('\u001b[1mdone\u001b[0m\n')).toBe('done');
  expect(progressLine('')).toBeUndefined();
});

const missing = (): Error => new Error("browserType.launchPersistentContext: Executable doesn't exist at /x/chrome");
function fakeChromium(behave: (channel: string | undefined, call: number) => unknown): { chromium: BrowserType; calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  const chromium = { launchPersistentContext: async (_profile: string, options: { channel?: string }) => {
    calls.push(options.channel);
    const result = behave(options.channel, calls.length);
    if (result instanceof Error) throw result;
    return result as BrowserContext;
  } } as unknown as BrowserType;
  return { chromium, calls };
}

it('uses Chrome when it is installed and fetches nothing', async () => {
  const { chromium, calls } = fakeChromium(channel => ({ channel }));
  let fetched = false;
  const context = await launchComputerBrowser(chromium, 'p', {}, dir, async () => { fetched = true; }) as unknown as { channel?: string };
  expect(context.channel).toBe('chrome');
  expect(calls).toEqual(['chrome']);
  expect(fetched).toBe(false);
});

it('falls back to a Chromium already downloaded, without fetching', async () => {
  const { chromium, calls } = fakeChromium(channel => channel ? missing() : { bundled: true });
  let fetched = false;
  expect(await launchComputerBrowser(chromium, 'p', {}, dir, async () => { fetched = true; })).toEqual({ bundled: true });
  expect(calls).toEqual(['chrome', 'msedge', undefined]);
  expect(fetched).toBe(false);
});

it('fetches Chromium once when no browser is there, reporting progress, then launches it', async () => {
  let downloaded = false;
  const { chromium, calls } = fakeChromium((channel) => channel || !downloaded ? missing() : { bundled: true });
  const seen: string[] = [];
  const context = await launchComputerBrowser(chromium, 'p', {}, dir, async onProgress => {
    onProgress('Downloading Chromium 10%');
    seen.push(JSON.stringify(await readHostStatus(dir)));
    downloaded = true;
  });
  expect(context).toEqual({ bundled: true });
  expect(calls).toEqual(['chrome', 'msedge', undefined, undefined]);
  expect(seen[0]).toContain('"state":"installing"');
  expect(JSON.parse(await readFile(installMarkerFile(dir), 'utf8'))).toMatchObject({ ok: true });
  // A second start that finds nothing does not download again.
  downloaded = false;
  let again = false;
  await expect(launchComputerBrowser(chromium, 'p', {}, dir, async () => { again = true; })).rejects.toThrow(/does not start/);
  expect(again).toBe(false);
});

it('gives a plain, actionable error when the download fails, and waits before trying again', async () => {
  const { chromium } = fakeChromium(() => missing());
  await expect(launchComputerBrowser(chromium, 'p', {}, dir, async () => { throw new Error('the download failed (exit 1): getaddrinfo ENOTFOUND cdn.playwright.dev'); }))
    .rejects.toThrow(/neither is installed.*ENOTFOUND.*npx playwright-core install chromium/s);
  let again = false;
  await expect(launchComputerBrowser(chromium, 'p', {}, dir, async () => { again = true; })).rejects.toThrow(/failed a short while ago/);
  expect(again).toBe(false);
});

it('does not hide a real launch failure behind a download', async () => {
  const { chromium } = fakeChromium(() => new Error('The profile is already in use'));
  let fetched = false;
  await expect(launchComputerBrowser(chromium, 'p', {}, dir, async () => { fetched = true; })).rejects.toThrow('already in use');
  expect(fetched).toBe(false);
});

it('names what to install on each system', () => {
  expect(noBrowserMessage('x')).toContain('npx playwright-core install chromium');
  expect(new NoBrowserError('x')).toBeInstanceOf(Error);
});

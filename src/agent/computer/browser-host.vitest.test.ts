import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { launchFirst, separateProfileDir, separateProfiles } from './browser-host.js';

it('uses the first browser that is installed', async () => {
  const tried: string[] = [];
  const result = await launchFirst(async channel => {
    tried.push(channel);
    if (channel === 'chrome') throw new Error("browserType.launch: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome");
    return channel;
  });
  expect(result).toBe('msedge');
  expect(tried).toEqual(['chrome', 'msedge']);
});

it('does not hide a real launch failure behind another browser', async () => {
  const tried: string[] = [];
  await expect(launchFirst(async channel => { tried.push(channel); throw new Error('The profile is already in use'); })).rejects.toThrow('already in use');
  expect(tried).toEqual(['chrome']);
});

it('says what to install when no browser is present', async () => {
  await expect(launchFirst(async () => { throw new Error("Executable doesn't exist at /x"); })).rejects.toThrow('Chrome or Microsoft Edge');
});

import { hiddenDisplayCommand } from './browser.js';
describe('hiddenDisplayCommand', () => {
  const hidden = ['env', '-u', 'WAYLAND_DISPLAY', 'CLIKCODE_BROWSER_VIRTUAL_DISPLAY=1', 'xvfb-run', '-a', '-s', '-screen 0 1440x900x24', 'node', 'x'];
  const desktop = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' };

  it('wraps in a virtual display on Linux by default, also on a desktop', () => {
    expect(hiddenDisplayCommand(['node', 'x'], {}, 'linux', () => true)).toEqual(hidden);
    expect(hiddenDisplayCommand(['node', 'x'], desktop, 'linux', () => true)).toEqual(hidden);
    expect(hiddenDisplayCommand(['node', 'x'], desktop, 'linux', () => true, { display: 'hidden' })).toEqual(hidden);
    expect(hiddenDisplayCommand(['node', 'x'], {}, 'darwin', () => true)).toEqual(['node', 'x']);
    expect(hiddenDisplayCommand(['node', 'x'], {}, 'linux', () => false)).toEqual(['node', 'x']);
  });

  it('starts on the desktop when the setting or the variable asks for visible and there is a desktop', () => {
    expect(hiddenDisplayCommand(['node', 'x'], desktop, 'linux', () => true, { display: 'visible' })).toEqual(['node', 'x']);
    expect(hiddenDisplayCommand(['node', 'x'], { ...desktop, CLIKCODE_BROWSER_VISIBLE: '1' }, 'linux', () => true)).toEqual(['node', 'x']);
    // A worker a service started has the session directory but no display variable: the host is told the desktop it found.
    const found = hiddenDisplayCommand(['node', 'x'], { XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux', () => true, { display: 'visible', socketExists: file => file === '/run/user/1000/wayland-0' });
    expect(found).toEqual(['env', '-u', 'CLIKCODE_BROWSER_VIRTUAL_DISPLAY', 'WAYLAND_DISPLAY=wayland-0', 'node', 'x']);
  });

  it('stays hidden, and says so, when visible is asked for with no desktop to be found', () => {
    let fellBack = 0;
    const none = { socketExists: () => false, onFallback: () => { fellBack++; } };
    expect(hiddenDisplayCommand(['node', 'x'], {}, 'linux', () => true, { display: 'visible', ...none })).toEqual(hidden);
    expect(hiddenDisplayCommand(['node', 'x'], { CLIKCODE_BROWSER_VISIBLE: '1', XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux', () => true, none)).toEqual(hidden);
    expect(fellBack).toBe(2);
    // Asked for on a desktop, nothing fell back.
    hiddenDisplayCommand(['node', 'x'], desktop, 'linux', () => true, { display: 'visible', ...none });
    hiddenDisplayCommand(['node', 'x'], desktop, 'linux', () => true, none);
    expect(fellBack).toBe(2);
  });

  it('leaves headless alone whatever the display setting', () => {
    expect(hiddenDisplayCommand(['node', 'x'], { ...desktop, CLIKCODE_BROWSER_HEADLESS: '1' }, 'linux', () => true, { display: 'visible' })).toEqual(['node', 'x']);
  });
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computerHostFile, hostDisplay, runningHostDisplay } from './browser-host.js';
describe('where the running browser shows itself', () => {
  it('is headless, hidden on the virtual display, or visible', () => {
    expect(hostDisplay({ headless: true, virtualDisplay: true })).toBe('headless');
    expect(hostDisplay({ headless: false, virtualDisplay: true })).toBe('hidden');
    expect(hostDisplay({ headless: false, virtualDisplay: false })).toBe('visible');
  });

  it('is read from the record of a host that is alive, and unknown otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-host-display-'));
    try {
      expect(await runningHostDisplay(dir)).toBeUndefined();
      await mkdir(join(dir, 'computer'), { recursive: true });
      await writeFile(computerHostFile(dir), JSON.stringify({ pid: 4242, display: 'visible' }));
      expect(await runningHostDisplay(dir, pid => pid === 4242)).toBe('visible');
      expect(await runningHostDisplay(dir, () => false)).toBeUndefined();
      // A host from before the record said where it is.
      await writeFile(computerHostFile(dir), JSON.stringify({ pid: 4242 }));
      expect(await runningHostDisplay(dir, () => true)).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

import { hostChromeArgs, plainUserAgent } from './browser-host.js';
describe('the host Chrome arguments', () => {
  it('keeps WebDriver hidden, and on a virtual display uses X11 and the real GPU instead of finding the user\'s Wayland desktop', () => {
    const plain = hostChromeArgs({ headless: false, virtualDisplay: false });
    expect(plain).toContain('--disable-blink-features=AutomationControlled');
    // Chrome keeps the last --disable-features: ours must be there to replace Playwright's, which turns Cast off (a bot tell).
    const features = plain.filter(arg => arg.startsWith('--disable-features='));
    expect(features).toHaveLength(1);
    expect(features[0]).not.toMatch(/MediaRouter/);
    expect(plain.some(arg => arg.startsWith('--ozone-platform'))).toBe(false);
    expect(hostChromeArgs({ headless: false, virtualDisplay: true })).toEqual(expect.arrayContaining(['--ozone-platform=x11', '--use-gl=angle', '--use-angle=gl-egl']));
    expect(hostChromeArgs({ headless: true, virtualDisplay: true })).toContain('--window-size=1440,900');
    expect(hostChromeArgs({ headless: true, virtualDisplay: true }).some(arg => arg.startsWith('--ozone-platform'))).toBe(false);
  });
});

describe('plainUserAgent', () => {
  it('drops the HeadlessChrome marker and leaves a plain agent alone', () => {
    expect(plainUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36'))
      .toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36');
    expect(plainUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36')).toBeUndefined();
  });
});

describe('separate profiles', () => {
  function fakeContext() {
    let onClose: (() => void) | undefined;
    const context = { closed: 0, once: (_: 'close', callback: () => void) => { onClose = callback; }, close: async () => { context.closed++; onClose?.(); } };
    return context;
  }

  it('starts one Chrome per name in its own directory, reuses it, and starts it again after its window closed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-sep-'));
    try {
      const launched: Array<{ dir: string; context: ReturnType<typeof fakeContext> }> = [];
      const profiles = separateProfiles(dir, async at => { const context = fakeContext(); launched.push({ dir: at, context }); return context as unknown as BrowserContext; }, async () => 9000 + launched.length);
      const [a, b] = await Promise.all([profiles.open('signup'), profiles.open('signup')]);
      expect(a).toEqual({ port: 9001 });
      expect(b).toEqual({ port: 9001 });
      expect(launched.map(item => item.dir)).toEqual([separateProfileDir(dir, 'signup')]);
      expect(separateProfileDir(dir, 'signup')).toBe(path.join(dir, 'computer', 'profiles', 'signup'));
      expect((await fs.stat(separateProfileDir(dir, 'signup'))).mode & 0o777).toBe(0o700);
      expect(await profiles.open('other')).toEqual({ port: 9002 });
      await launched[0]!.context.close();
      expect(await profiles.open('signup')).toEqual({ port: 9003 });
      await profiles.closeAll();
      expect(launched.map(item => item.context.closed)).toEqual([1, 1, 1]);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('a Chrome that never opens its port is closed and the next ask tries again', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-sep-'));
    try {
      const contexts: Array<ReturnType<typeof fakeContext>> = [];
      let fail = true;
      const profiles = separateProfiles(dir, async () => { const context = fakeContext(); contexts.push(context); return context as unknown as BrowserContext; },
        async () => { if (fail) throw new Error('no port'); return 9100; });
      await expect(profiles.open('signup')).rejects.toThrow('no port');
      expect(contexts[0]!.closed).toBe(1);
      fail = false;
      expect(await profiles.open('signup')).toEqual({ port: 9100 });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

import { describe, expect, it } from 'vitest';
import { launchFirst } from './browser-host.js';

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
  it('wraps in a virtual display on Linux, unless visible is asked for', () => {
    expect(hiddenDisplayCommand(['node', 'x'], {}, 'linux', () => true)).toEqual(['env', '-u', 'WAYLAND_DISPLAY', 'CLIKCODE_BROWSER_VIRTUAL_DISPLAY=1', 'xvfb-run', '-a', '-s', '-screen 0 1440x900x24', 'node', 'x']);
    expect(hiddenDisplayCommand(['node', 'x'], { CLIKCODE_BROWSER_VISIBLE: '1' }, 'linux', () => true)).toEqual(['node', 'x']);
    expect(hiddenDisplayCommand(['node', 'x'], {}, 'darwin', () => true)).toEqual(['node', 'x']);
    expect(hiddenDisplayCommand(['node', 'x'], {}, 'linux', () => false)).toEqual(['node', 'x']);
  });
});

import { hostChromeArgs } from './browser-host.js';
describe('the host Chrome arguments', () => {
  it('keeps WebDriver hidden, and on a virtual display uses X11 and the real GPU instead of finding the user\'s Wayland desktop', () => {
    const plain = hostChromeArgs({ headless: false, virtualDisplay: false });
    expect(plain).toContain('--disable-blink-features=AutomationControlled');
    expect(plain.some(arg => arg.startsWith('--ozone-platform'))).toBe(false);
    expect(hostChromeArgs({ headless: false, virtualDisplay: true })).toEqual(expect.arrayContaining(['--ozone-platform=x11', '--use-gl=angle', '--use-angle=gl-egl']));
    expect(hostChromeArgs({ headless: true, virtualDisplay: true })).toContain('--window-size=1440,900');
    expect(hostChromeArgs({ headless: true, virtualDisplay: true }).some(arg => arg.startsWith('--ozone-platform'))).toBe(false);
  });
});

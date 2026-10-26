import { describe, expect, it } from 'vitest';
import { DESKTOP_SERVICE_LABEL, desktopServicePlist, desktopServiceStep } from './driver-macos-session.js';

const base = { platform: 'darwin' as NodeJS.Platform, session: 'Background', desktopDomain: true, loaded: false, running: false };

describe('starting cua-driver in the macOS desktop session', () => {
  it('does nothing off macOS, inside the desktop session, or with no one logged in at the screen', () => {
    expect(desktopServiceStep({ ...base, platform: 'linux' })).toBe('none');
    expect(desktopServiceStep({ ...base, session: 'Aqua' })).toBe('none');
    expect(desktopServiceStep({ ...base, desktopDomain: false })).toBe('none');
  });

  it('loads the agent from a background session, restarts it when stopped, and leaves a running one alone', () => {
    expect(desktopServiceStep(base)).toBe('bootstrap');
    expect(desktopServiceStep({ ...base, loaded: true })).toBe('kickstart');
    expect(desktopServiceStep({ ...base, loaded: true, running: true })).toBe('none');
  });

  it('runs the daemon in the Aqua session only, for this login', () => {
    const plist = desktopServicePlist('/Applications/CuaDriver.app/Contents/MacOS/cua-driver');
    expect(plist).toContain(`<string>${DESKTOP_SERVICE_LABEL}</string>`);
    expect(plist).toContain('<string>/Applications/CuaDriver.app/Contents/MacOS/cua-driver</string><string>serve</string>');
    expect(plist).toContain('<key>LimitLoadToSessionType</key><string>Aqua</string>');
    expect(plist).not.toContain('KeepAlive');
    expect(desktopServicePlist('/a&b<c')).toContain('/a&amp;b&lt;c');
  });
});

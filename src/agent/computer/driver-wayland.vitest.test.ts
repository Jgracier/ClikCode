import { describe, expect, it } from 'vitest';
import { gnomeMajor, waylandHelperVerdict } from './driver-wayland.js';

const gnome = (version: string, extra: Partial<Parameters<typeof waylandHelperVerdict>[0]> = {}) =>
  waylandHelperVerdict({ platform: 'linux', desktop: 'ubuntu:GNOME', sessionType: 'wayland', gnomeShellOutput: `GNOME Shell ${version}\n`, ...extra });

describe('the GNOME Wayland helper', () => {
  it('reads the GNOME major version', () => {
    expect(gnomeMajor('GNOME Shell 49.2\n')).toBe(49);
    expect(gnomeMajor('GNOME Shell 50.1')).toBe(50);
    expect(gnomeMajor('')).toBeUndefined();
  });

  it('is allowed on GNOME 45 to 49 only', () => {
    for (const version of ['45.0', '47.3', '49.2']) expect(gnome(version), version).toMatchObject({ ok: true });
    expect(gnome('50.1')).toMatchObject({ ok: false, reason: expect.stringContaining('crashed the Shell') });
    expect(gnome('51.0')).toMatchObject({ ok: false });
    expect(gnome('44.9')).toMatchObject({ ok: false, reason: expect.stringContaining('older') });
  });

  it('is refused off GNOME, off Linux, off Wayland, or when the version is unreadable', () => {
    expect(gnome('47.0', { desktop: 'KDE' })).toMatchObject({ ok: false });
    expect(gnome('47.0', { platform: 'darwin' })).toMatchObject({ ok: false });
    expect(gnome('47.0', { sessionType: 'x11' })).toMatchObject({ ok: false, reason: expect.stringContaining('Wayland') });
    expect(waylandHelperVerdict({ platform: 'linux', desktop: 'GNOME' })).toMatchObject({ ok: false, reason: expect.stringContaining('version') });
  });
});

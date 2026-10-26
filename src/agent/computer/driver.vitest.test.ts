import { describe, expect, it } from 'vitest';
import { DRIVER_MISSING, driverHome, driverMcpArgs, findDriverBinary } from './driver.js';

describe('finding cua-driver', () => {
  it('prefers the one on PATH, then our own active release, then the macOS app', () => {
    const has = (...paths: string[]) => (path: string) => paths.includes(path);
    expect(findDriverBinary({ PATH: '/a:/usr/local/bin', HOME: '/h' }, 'linux', has('/usr/local/bin/cua-driver', '/h/.cua-driver/packages/current/cua-driver'))).toBe('/usr/local/bin/cua-driver');
    expect(findDriverBinary({ PATH: '/a' }, 'linux', has(`${driverHome({})}/packages/current/cua-driver`))).toBe(`${driverHome({})}/packages/current/cua-driver`);
    expect(findDriverBinary({ PATH: '/a', CUA_DRIVER_RS_HOME: '/opt/cua' }, 'linux', has('/opt/cua/packages/current/cua-driver'))).toBe('/opt/cua/packages/current/cua-driver');
    expect(findDriverBinary({ PATH: '/a' }, 'darwin', has('/Applications/CuaDriver.app/Contents/MacOS/cua-driver'))).toBe('/Applications/CuaDriver.app/Contents/MacOS/cua-driver');
    expect(findDriverBinary({ PATH: '/a' }, 'linux', has())).toBeUndefined();
  });

  it('looks for cua-driver.exe on Windows', () => {
    expect(findDriverBinary({ PATH: 'C:\\bin;C:\\tools' }, 'win32', (path) => path.endsWith('cua-driver.exe') && path.includes('tools'))).toMatch(/tools.*cua-driver\.exe$/);
  });

  it('names the one command that installs it', () => {
    expect(DRIVER_MISSING).toContain('clikcode computer driver install');
  });
});

describe('how cua-driver is started', () => {
  it('lets CuaDriver.app own the permissions on macOS and runs in-process elsewhere', () => {
    expect(driverMcpArgs('darwin')).toEqual(['mcp']);
    expect(driverMcpArgs('linux')).toEqual(['mcp', '--direct']);
    expect(driverMcpArgs('win32')).toEqual(['mcp', '--direct']);
  });
});

import { describe, expect, it } from 'vitest';
import { isAllowedLoopbackHost } from './host-allowlist.js';

describe('isAllowedLoopbackHost', () => {
  const port = 43117;

  it.each([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `LOCALHOST:${port}`,
    `[::1]:${port}`,
  ])('allows %s', (host) => {
    expect(isAllowedLoopbackHost(host, port)).toBe(true);
  });

  it.each([
    ['missing header', undefined],
    ['null header', null],
    ['empty header', ''],
    ['repeated header', [`127.0.0.1:${port}`, `127.0.0.1:${port}`]],
    ['rebinding hostname', `attacker.example:${port}`],
    ['loopback-looking suffix', `127.0.0.1.attacker.example:${port}`],
    ['loopback-looking prefix', `localhost.attacker.example:${port}`],
    ['no port', '127.0.0.1'],
    ['no port localhost', 'localhost'],
    ['no port ipv6', '[::1]'],
    ['wrong port', '127.0.0.1:80'],
    ['other port on localhost', `localhost:${port + 1}`],
    ['zero-padded port', `127.0.0.1:0${port}`],
    ['signed port', `127.0.0.1:+${port}`],
    ['trailing dot', `localhost.:${port}`],
    ['other loopback address', `127.0.0.2:${port}`],
    ['wildcard address', `0.0.0.0:${port}`],
    ['unbracketed ipv6', `::1:${port}`],
    ['expanded ipv6', `[0:0:0:0:0:0:0:1]:${port}`],
    ['ipv4-mapped ipv6', `[::ffff:127.0.0.1]:${port}`],
    ['userinfo', `user@127.0.0.1:${port}`],
    ['userinfo smuggling', `127.0.0.1:${port}@attacker.example`],
    ['path', `127.0.0.1:${port}/v1/health`],
    ['leading whitespace', ` 127.0.0.1:${port}`],
    ['trailing whitespace', `127.0.0.1:${port} `],
    ['comma list', `127.0.0.1:${port}, attacker.example`],
    ['decimal ip', `2130706433:${port}`],
  ])('rejects %s', (_name, host) => {
    expect(isAllowedLoopbackHost(host as string | undefined, port)).toBe(false);
  });

  it('rejects an invalid expected port', () => {
    expect(isAllowedLoopbackHost('127.0.0.1:0', 0)).toBe(false);
    expect(isAllowedLoopbackHost('127.0.0.1:NaN', Number.NaN)).toBe(false);
    expect(isAllowedLoopbackHost('127.0.0.1:70000', 70000)).toBe(false);
  });
});

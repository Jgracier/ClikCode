import { expect, it } from 'vitest';
import { findTailnetAddress, tailnetAddress } from './tailnet-handoff.js';

const entry = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '', mac: '', cidr: null });

it('takes a 100.64/10 address only on Tailscale\'s own interface: an ISP\'s carrier-grade NAT address is not a tailnet', () => {
  expect(tailnetAddress({ lo: [entry('127.0.0.1', true)], eth0: [entry('192.168.1.5')], tailscale0: [entry('100.70.212.126')] })).toBe('100.70.212.126');
  expect(tailnetAddress({ Tailscale: [entry('100.70.212.126')] })).toBe('100.70.212.126');
  // CGNAT from the ISP (or a phone hotspot) on the ordinary interface: binding there would serve the handoff to the ISP's network.
  expect(tailnetAddress({ eth0: [entry('100.72.13.9')], wlan0: [entry('100.100.4.4')] })).toBeUndefined();
});

it('on macOS (utunN) an address counts only when `tailscale ip -4` reports it and an interface holds it', async () => {
  const interfaces = { en0: [entry('100.72.13.9')], utun4: [entry('100.70.212.126')] };
  expect(await findTailnetAddress({ interfaces, ask: async () => '100.70.212.126' })).toBe('100.70.212.126');
  expect(await findTailnetAddress({ interfaces, ask: async () => undefined })).toBeUndefined();
  // The daemon names an address no interface here holds: nothing to bind.
  expect(await findTailnetAddress({ interfaces, ask: async () => '100.99.1.1' })).toBeUndefined();
  expect(await findTailnetAddress({ interfaces, ask: async () => { throw new Error('timed out'); } })).toBeUndefined();
});

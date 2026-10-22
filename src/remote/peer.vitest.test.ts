import { describe, expect, it } from 'vitest';
import { peerFromStatus, validPeer, withPeer, type PeerMachine } from './peer.js';
import { newMachineRecord, type RemoteMachine } from './machines.js';

const status = { BackendState: 'Running', Self: { ID: 'nLinux', HostName: 'justin-gracier-SER8', DNSName: 'linux.tail54ec51.ts.net.', UserID: 1 } };
const peer: PeerMachine = {
  name: 'linux', sshTarget: 'justin-gracier@linux.tail54ec51.ts.net',
  tailscale: { nodeId: 'nLinux', dnsName: 'linux.tail54ec51.ts.net' }, os: 'linux', installationId: 'inst-linux', version: '1.0.0', commit: 'abc',
};

describe('a machine connected to lists the one connecting', () => {
  it('says how to reach it back: its MagicDNS name and its user', () => {
    expect(peerFromStatus(status, { user: 'justin-gracier', installationId: 'inst-linux', platform: 'linux' })).toMatchObject({
      name: 'linux', sshTarget: 'justin-gracier@linux.tail54ec51.ts.net', tailscale: { nodeId: 'nLinux', dnsName: 'linux.tail54ec51.ts.net' }, os: 'linux', installationId: 'inst-linux',
    });
  });

  it('says nothing without Tailscale: no address the other machine is known to reach', () => {
    expect(peerFromStatus(undefined, { user: 'me' })).toBeUndefined();
    expect(peerFromStatus({ Self: { ID: 'n1' } }, { user: 'me' })).toBeUndefined();
  });

  it('is added there, ready, updated only when asked', () => {
    const [added] = withPeer([], peer, 'inst-mac');
    expect(added).toMatchObject({ name: 'linux', sshTarget: peer.sshTarget, ready: true, updates: 'ask', installationId: 'inst-linux', installed: { version: '1.0.0', commit: 'abc' } });
  });

  it('refreshes the record there, keeping the address and policy the user gave', () => {
    const mine: RemoteMachine = { ...newMachineRecord({ name: 'workstation', sshTarget: 'me@10.0.0.5' }), installationId: 'inst-linux', updates: 'auto' };
    const [record, ...rest] = withPeer([mine], peer, 'inst-mac');
    expect(rest).toEqual([]);
    expect(record).toMatchObject({ id: mine.id, name: 'workstation', sshTarget: 'me@10.0.0.5', updates: 'auto', ready: true, installed: { commit: 'abc' } });
  });

  it('finishes a half-added record of the same node: ClikCode answered from there', () => {
    const half: RemoteMachine = newMachineRecord({ name: 'linux', sshTarget: 'justin-gracier@linux.tail54ec51.ts.net', tailscale: { nodeId: 'nLinux' } });
    expect(withPeer([half], peer, 'inst-mac')).toEqual([expect.objectContaining({ id: half.id, ready: true, installationId: 'inst-linux' })]);
  });

  it('adds nothing for a connection from this same installation', () => {
    expect(withPeer([], peer, 'inst-linux')).toEqual([]);
  });

  it('takes only a peer that is one: it came over the wire', () => {
    expect(validPeer(peer)).toBe(true);
    expect(validPeer({ ...peer, sshTarget: '-oProxyCommand=x' })).toBe(false);
    expect(validPeer({ ...peer, tailscale: undefined })).toBe(false);
    expect(validPeer(undefined)).toBe(false);
  });
});

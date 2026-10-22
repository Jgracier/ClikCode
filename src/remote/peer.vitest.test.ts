import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { announceWhenReady, peerFromStatus, recordPeer, validPeer, withPeer, type PeerMachine } from './peer.js';
import { forgetMachine, newMachineRecord, readMachines, updateMachines, type RemoteMachine } from './machines.js';

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
    const [added] = withPeer([], peer, 'inst-mac', { add: true });
    expect(added).toMatchObject({ name: 'linux', sshTarget: peer.sshTarget, ready: true, updates: 'ask', addedBy: 'peer', installationId: 'inst-linux', installed: { version: '1.0.0', commit: 'abc' } });
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

  it('one machine is one record: a half-finished add of it under its other Tailscale name is dropped', () => {
    // The MacBook as it was here: added and installed as `macbook`, and half-added as
    // `justins-macbook-pro` -- the node it now says it is.
    const mac: PeerMachine = { name: 'justins-macbook-pro', sshTarget: 'chronos@justins-macbook-pro.ts.net', tailscale: { nodeId: 'nPro', dnsName: 'justins-macbook-pro.ts.net' }, installationId: 'inst-mac', version: '1' };
    const added: RemoteMachine = { ...newMachineRecord({ name: 'macbook', sshTarget: 'chronos@macbook.ts.net', tailscale: { nodeId: 'nOld' } }), installationId: 'inst-mac', ready: true, installed: { version: '1', at: '2026-10-01T00:00:00Z' } };
    const half: RemoteMachine = newMachineRecord({ name: 'justins-macbook-pro', sshTarget: 'chronos@justins-macbook-pro.ts.net', tailscale: { nodeId: 'nPro' } });
    expect(withPeer([half, added], mac, 'inst-linux')).toEqual([expect.objectContaining({ id: added.id, name: 'macbook', sshTarget: 'chronos@macbook.ts.net', ready: true })]);
    // Both finished already (the same installation twice): the first install is kept.
    const twice: RemoteMachine = { ...half, installationId: 'inst-mac', ready: true, installed: { version: '1', at: '2026-10-22T00:00:00Z' } };
    expect(withPeer([twice, added], mac, 'inst-linux').map((record) => record.id)).toEqual([added.id]);
  });

  it('adds nothing for a connection from this same installation', () => {
    expect(withPeer([], peer, 'inst-linux', { add: true })).toEqual([]);
  });

  it('one it added itself follows its new address; nothing removed comes back', () => {
    const [record] = withPeer([], peer, 'inst-mac', { add: true });
    const moved = { ...peer, name: 'workbox', sshTarget: 'jg@workbox.tail54ec51.ts.net', tailscale: { nodeId: 'nLinux', dnsName: 'workbox.tail54ec51.ts.net' } };
    expect(withPeer([record!], moved, 'inst-mac')).toEqual([expect.objectContaining({ id: record!.id, name: 'workbox', sshTarget: 'jg@workbox.tail54ec51.ts.net' })]);
    expect(withPeer([], peer, 'inst-mac', { add: true, forgotten: [{ installationId: 'inst-linux', at: '' }] })).toEqual([]);
    expect(withPeer([], peer, 'inst-mac', { add: true, forgotten: [{ nodeId: 'nLinux', at: '' }] })).toEqual([]);
  });

  it('takes only a peer that is one: it came over the wire', () => {
    expect(validPeer(peer)).toBe(true);
    expect(validPeer({ ...peer, sshTarget: '-oProxyCommand=x' })).toBe(false);
    expect(validPeer({ ...peer, tailscale: undefined })).toBe(false);
    expect(validPeer(undefined)).toBe(false);
  });
});

describe('recording a machine that connected here', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cc-peer-')); process.env.CLIKCODE_HOME = home; });
  afterEach(() => { delete process.env.CLIKCODE_HOME; rmSync(home, { recursive: true, force: true }); });

  it('lists it only once it is reachable back from here', async () => {
    expect(await recordPeer(peer, async () => false)).toBe('unreachable');
    expect(await readMachines()).toEqual([]);
    expect(await recordPeer(peer, async () => true)).toBe('added');
    expect(await readMachines()).toEqual([expect.objectContaining({ name: 'linux', addedBy: 'peer', ready: true })]);
    // Known now: refreshed without logging in again.
    expect(await recordPeer({ ...peer, commit: 'def' }, async () => { throw new Error('not asked'); })).toBe('refreshed');
    expect((await readMachines())[0]!.installed?.commit).toBe('def');
  });

  it('does not add one the user removed, until it is added again by hand', async () => {
    await recordPeer(peer, async () => true);
    const [record] = await readMachines();
    await forgetMachine(record!.id, { remember: true });
    expect(await recordPeer(peer, async () => true)).toBe('skipped');
    expect(await readMachines()).toEqual([]);
    // Added by hand: listed, and no longer forgotten -- it refreshes, and removing it plainly does not remember it.
    await updateMachines((machines) => [...machines, { ...newMachineRecord({ name: 'linux', sshTarget: peer.sshTarget }), installationId: 'inst-linux' }]);
    expect(await recordPeer(peer, async () => true)).toBe('refreshed');
    const [again] = await readMachines();
    await forgetMachine(again!.id);
    expect(await recordPeer(peer, async () => true)).toBe('added');
  });
});

describe('every connection tells the machine there who is connecting', () => {
  it('after its host-ready, once', async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const sent: string[] = [];
    stdin.on('data', (chunk: Buffer) => sent.push(chunk.toString('utf8')));
    announceWhenReady({ stdout, stdin } as never, async () => peer);
    stdout.write('{"type":"chat","chat":"x","event":{"type":"ready"}}\n{"type":"host-');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toEqual([]);
    stdout.write('ready","version":"1"}\n{"type":"host-ready"}\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.map((line) => JSON.parse(line))).toEqual([{ type: 'host-peer', machine: peer }]);
  });
});

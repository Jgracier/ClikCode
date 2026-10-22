/** Both ways: a machine that drives another can be driven from it.
 *
 * When a connection to an added machine opens (connection.ts), this machine
 * tells the ClikCode there how to reach it back (`host-peer`): its Tailscale
 * name and the user it runs as. The machine there adds it to its own
 * machines.json, or refreshes the record it has -- so in /machine there,
 * this machine is listed, its chats are on that board, and a chat moves
 * back here like to any other machine.
 *
 * Only over Tailscale: its MagicDNS name is an address the other machine is
 * known to reach (it reached the other way), where a LAN address or a
 * hostname is a guess. Without Tailscale here, nothing is sent; the other
 * machine can still add this one by its SSH address.
 *
 * A record made this way is updated only when the user says so ('ask'): two
 * machines each bringing the other to its own build would undo each other's
 * updates. A record that exists keeps its address and policy -- the user's
 * -- and is only refreshed (installation, version, last seen). */
import { hostname, userInfo } from 'node:os';
import { CLIKCODE_COMMIT, CLIKCODE_VERSION } from '../version.js';
import { readState } from '../session/state/read.js';
import { newMachineRecord, updateMachines, type RemoteMachine } from './machines.js';
import { readTailscaleStatus, type TailscaleStatus } from './tailscale.js';
import { targetHost, validateSshTarget, withUser } from './shell.js';

/** What a machine says of itself to one it connects to. */
export interface PeerMachine {
  name: string;
  /** How the machine it is sent to reaches it: user@<MagicDNS name>. */
  sshTarget: string;
  tailscale: { nodeId: string; dnsName: string };
  os?: string;
  installationId?: string;
  version: string;
  commit?: string;
}

const OS_NAMES: Readonly<Record<string, string>> = { darwin: 'macOS', linux: 'linux' };

/** This machine as a peer, from Tailscale's own record of it; undefined
 * without Tailscale (or a name in it). Pure: tested on fixtures. */
export function peerFromStatus(status: TailscaleStatus | undefined, facts: { user: string; installationId?: string; platform?: string; host?: string }): PeerMachine | undefined {
  const self = status?.Self;
  const dnsName = self?.DNSName?.replace(/\.$/, '');
  if (!self?.ID || !dnsName) return undefined;
  let sshTarget: string;
  try { sshTarget = withUser(validateSshTarget(dnsName), facts.user); } catch { return undefined; }
  const os = OS_NAMES[facts.platform ?? process.platform];
  return {
    name: dnsName.split('.')[0] || self.HostName || facts.host || dnsName, sshTarget,
    tailscale: { nodeId: self.ID, dnsName },
    ...(os ? { os } : {}), ...(facts.installationId ? { installationId: facts.installationId } : {}),
    version: CLIKCODE_VERSION, ...(CLIKCODE_COMMIT ? { commit: CLIKCODE_COMMIT } : {}),
  };
}

let self: Promise<PeerMachine | undefined> | undefined;

/** This machine as a peer: read once per process. */
export function selfAsPeer(): Promise<PeerMachine | undefined> {
  self ??= (async () => {
    const [{ status }, installationId] = await Promise.all([
      readTailscaleStatus(),
      readState({ transcripts: [] }).then((state) => state.installationId, () => undefined),
    ]);
    const user = (() => { try { return userInfo().username; } catch { return process.env.USER ?? ''; } })();
    if (!user) return undefined;
    return peerFromStatus(status, { user, ...(installationId ? { installationId } : {}), host: hostname() });
  })().catch(() => undefined);
  return self;
}

/** Whether a peer is the machine `record` is: the same installation, else
 * the same Tailscale node, else the same host (a record added by hand). */
function samePeer(record: RemoteMachine, peer: PeerMachine): boolean {
  if (record.installationId && peer.installationId) return record.installationId === peer.installationId;
  if (record.tailscale?.nodeId === peer.tailscale.nodeId) return true;
  return targetHost(record.sshTarget).toLowerCase() === peer.tailscale.dnsName.toLowerCase();
}

/** The machine list after `peer` connected here: it is added, or its record
 * refreshed. Pure. `own` is this machine's installation id: a connection
 * from this same installation adds nothing. */
export function withPeer(machines: readonly RemoteMachine[], peer: PeerMachine, own: string | undefined, now = new Date()): RemoteMachine[] {
  if (peer.installationId && peer.installationId === own) return [...machines];
  const at = now.toISOString();
  const installed = { version: peer.version, ...(peer.commit ? { commit: peer.commit } : {}), at };
  const existing = machines.find((record) => samePeer(record, peer));
  if (existing) {
    return machines.map((record) => (record !== existing ? record : {
      ...record,
      ...(peer.installationId ? { installationId: peer.installationId } : {}),
      // It answered from there with ClikCode running: its install is done.
      ready: true, installed, lastSeen: at,
      ...(record.tailscale ? {} : { tailscale: peer.tailscale }),
      ...(record.os || !peer.os ? {} : { os: peer.os }),
    }));
  }
  return [...machines, newMachineRecord({
    name: peer.name, sshTarget: peer.sshTarget, tailscale: peer.tailscale,
    ...(peer.os ? { os: peer.os } : {}), ...(peer.installationId ? { installationId: peer.installationId } : {}),
    ready: true, installed, lastSeen: at, updates: 'ask',
  })];
}

/** A `host-peer` arrived (ide/bridge-mux.ts): recorded in machines.json. */
export async function recordPeer(peer: PeerMachine): Promise<void> {
  if (!validPeer(peer)) return;
  const own = await readState({ transcripts: [] }).then((state) => state.installationId, () => undefined);
  await updateMachines((machines) => withPeer(machines, peer, own));
}

/** Whether what arrived is a peer at all: it came over the wire. */
export function validPeer(peer: unknown): peer is PeerMachine {
  const value = peer as Partial<PeerMachine> | undefined;
  if (!value || typeof value.name !== 'string' || !value.name || typeof value.sshTarget !== 'string' || typeof value.version !== 'string') return false;
  if (typeof value.tailscale?.nodeId !== 'string' || typeof value.tailscale.dnsName !== 'string') return false;
  try { validateSshTarget(value.sshTarget); } catch { return false; }
  return true;
}

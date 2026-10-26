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
 * A machine is added this way only once this one has logged in to it with
 * the address it gave (a tailnet policy may allow one way only): nothing is
 * listed that cannot be reached. One the user removed here does not add
 * itself back; adding it again by hand undoes that (machines.ts forgotten).
 *
 * A record made this way is updated only when the user says so ('ask'): two
 * machines each bringing the other to its own build would undo each other's
 * updates. It follows what the machine says of itself (addedBy 'peer'); one
 * the user added keeps the address and policy the user gave, and is only
 * refreshed (installation, version, last seen). */
import { quiet } from '../runtime/lifecycle-log.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { readFile } from 'node:fs/promises';
import type { IdeHostRequest } from '../ide/protocol.js';
import { CLIKCODE_COMMIT, CLIKCODE_VERSION } from '../version.js';
import { harnessIndexPath } from '../session/state/paths.js';
import { isForgotten, newMachineRecord, readForgotten, readMachines, updateMachines, type ForgottenMachine, type RemoteMachine } from './machines.js';
import { readTailscaleStatus, type TailscaleStatus } from './tailscale.js';
import { targetHost, validateSshTarget, withUser } from './shell.js';
import { runSsh, spawnSsh } from './ssh.js';
import { bridgeScript } from './install.js';

/** Starts `target`'s bridge (`ide-bridge --stdio` over ssh) and, once it
 * is ready, tells it who is connecting. Every connection to another machine
 * starts here -- the board's and /machine's (connection.ts), a terminal chat
 * running there (terminal-chat.ts), VS Code's (ssh-bridge-client.ts) -- so
 * whichever way this machine reaches another, that one can reach it back. */
export function startBridge(target: string, self: () => Promise<PeerMachine | undefined> = selfAsPeer): ChildProcessWithoutNullStreams {
  const child = spawnSsh(target, bridgeScript());
  announceWhenReady(child, self);
  return child;
}

/** Sends `host-peer` after the bridge's host-ready: not before it, when the
 * bridge there may not be listening yet. Once per bridge process (a bridge
 * that retires is a new process, and a new start). Reads its own copy of the
 * lines: the caller's reader is left as it is. */
export function announceWhenReady(child: Pick<ChildProcessWithoutNullStreams, 'stdout' | 'stdin'>, self: () => Promise<PeerMachine | undefined>): void {
  let pending = '';
  const onData = (chunk: Buffer): void => {
    pending += chunk.toString('utf8');
    for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (!line.includes('"host-ready"')) continue;
      try { if ((JSON.parse(line) as { type?: string }).type !== 'host-ready') continue; } catch { continue; }
      child.stdout.off('data', onData);
      pending = '';
      void self().then((peer) => {
        if (peer && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ type: 'host-peer', machine: peer } satisfies IdeHostRequest)}\n`);
      }, () => undefined);
      return;
    }
  };
  child.stdout.on('data', onData);
}

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

/** Peer discovery only observes an existing installation. Loading full CLI
 * state here pulled its ESM runtime into the CommonJS VS Code extension. */
async function readInstallationId(): Promise<string | undefined> {
  try {
    const index = JSON.parse(await readFile(harnessIndexPath(), 'utf8')) as { installationId?: unknown };
    return typeof index.installationId === 'string' ? index.installationId : undefined;
  } catch { return undefined; /* Identity is optional when no readable index exists. */ }
}

/** This machine as a peer: read once per process. */
export function selfAsPeer(): Promise<PeerMachine | undefined> {
  self ??= (async () => {
    const [{ status }, installationId] = await Promise.all([
      readTailscaleStatus(),
      readInstallationId(),
    ]);
    const user = (() => { try { return userInfo().username; } catch { return process.env.USER ?? ''; } })();
    if (!user) return undefined;
    return peerFromStatus(status, { user, ...(installationId ? { installationId } : {}), host: hostname() });
  })().catch(quiet('remote/peer'));
  return self;
}

/** The records of the machine `peer` is: the one to keep, and the others
 * -- the same machine added twice, or a half-finished add of it -- to drop.
 * Its installation says which machine it is: records of that installation
 * (the oldest install kept), and records with none that reach it by node or
 * host (half-finished adds of it). Only when no record has its installation
 * is one of those it: the half-finished add, finished now. A record of
 * another installation on that node is another machine. */
function recordsOf(machines: readonly RemoteMachine[], peer: PeerMachine): { keep?: RemoteMachine; drop: RemoteMachine[] } {
  const reaches = (record: RemoteMachine): boolean => record.tailscale?.nodeId === peer.tailscale.nodeId
    || targetHost(record.sshTarget).toLowerCase() === peer.tailscale.dnsName.toLowerCase();
  const loose = machines.filter((record) => !record.installationId && reaches(record));
  const same = peer.installationId ? machines.filter((record) => record.installationId === peer.installationId) : [];
  if (!same.length) return { ...(loose[0] ? { keep: loose[0] } : {}), drop: loose.slice(1) };
  const installedAt = (record: RemoteMachine): number => Date.parse(record.installed?.at ?? record.addedAt) || Infinity;
  const [keep, ...others] = [...same].sort((left, right) => installedAt(left) - installedAt(right));
  return { keep, drop: [...others, ...loose] };
}

/** The machine list after `peer` connected here: its record refreshed, or
 * it added (`add`: once it was found to be reachable back). Pure. `own` is
 * this machine's installation id: a connection from this same installation
 * adds nothing; nor does one from a machine the user removed. */
export function withPeer(
  machines: readonly RemoteMachine[], peer: PeerMachine, own: string | undefined,
  options: { forgotten?: readonly ForgottenMachine[]; add?: boolean; now?: Date } = {},
): RemoteMachine[] {
  if (peer.installationId && peer.installationId === own) return [...machines];
  const at = (options.now ?? new Date()).toISOString();
  const installed = { version: peer.version, ...(peer.commit ? { commit: peer.commit } : {}), at };
  const { keep: existing, drop } = recordsOf(machines, peer);
  if (existing) {
    // One it added itself follows what it says of itself (a new name, a new
    // user); one the user added keeps the address and policy the user gave.
    const own = existing.addedBy === 'peer' ? { name: peer.name, sshTarget: peer.sshTarget, tailscale: peer.tailscale } : {};
    return machines.filter((record) => !drop.includes(record)).map((record) => (record !== existing ? record : {
      ...record, ...own,
      ...(peer.installationId ? { installationId: peer.installationId } : {}),
      // It answered from there with ClikCode running: its install is done.
      ready: true, installed, lastSeen: at,
      ...(record.tailscale ? {} : { tailscale: peer.tailscale }),
      ...(record.os || !peer.os ? {} : { os: peer.os }),
    }));
  }
  if (!options.add || isForgotten(options.forgotten ?? [], { ...(peer.installationId ? { installationId: peer.installationId } : {}), nodeId: peer.tailscale.nodeId })) return [...machines];
  return [...machines, newMachineRecord({
    name: peer.name, sshTarget: peer.sshTarget, tailscale: peer.tailscale,
    ...(peer.os ? { os: peer.os } : {}), ...(peer.installationId ? { installationId: peer.installationId } : {}),
    ready: true, installed, lastSeen: at, updates: 'ask', addedBy: 'peer',
  })];
}

/** Whether a peer not listed here yet would be added: not this machine, not
 * one the user removed. */
function wouldAdd(machines: readonly RemoteMachine[], forgotten: readonly ForgottenMachine[], peer: PeerMachine, own: string | undefined): boolean {
  if (peer.installationId && peer.installationId === own) return false;
  if (recordsOf(machines, peer).keep) return false;
  return !isForgotten(forgotten, { ...(peer.installationId ? { installationId: peer.installationId } : {}), nodeId: peer.tailscale.nodeId });
}

/** Whether this machine can log in to the peer: a machine it could not
 * reach (a tailnet policy that allows one way only) is not listed at all. */
export type ReachBack = (target: string) => Promise<boolean>;
const sshReachBack: ReachBack = async (target) => (await runSsh(target, 'true', { timeoutMs: 20_000 })).code === 0;

/** A `host-peer` arrived (ide/bridge-mux.ts): recorded in machines.json. */
export async function recordPeer(peer: PeerMachine, reach: ReachBack = sshReachBack): Promise<'refreshed' | 'added' | 'unreachable' | 'skipped'> {
  if (!validPeer(peer)) return 'skipped';
  const own = await readInstallationId();
  const [machines, forgotten] = await Promise.all([readMachines(), readForgotten()]);
  const adding = wouldAdd(machines, forgotten, peer, own);
  if (!adding) {
    if (!recordsOf(machines, peer).keep) return 'skipped';
    await updateMachines((list, gone) => withPeer(list, peer, own, { forgotten: gone }));
    return 'refreshed';
  }
  // Outside the write: an ssh login takes seconds.
  if (!await reach(peer.sshTarget).catch(() => false)) return 'unreachable';
  await updateMachines((list, gone) => withPeer(list, peer, own, { forgotten: gone, add: true }));
  return 'added';
}

/** Whether what arrived is a peer at all: it came over the wire. */
export function validPeer(peer: unknown): peer is PeerMachine {
  const value = peer as Partial<PeerMachine> | undefined;
  if (!value || typeof value.name !== 'string' || !value.name || typeof value.sshTarget !== 'string' || typeof value.version !== 'string') return false;
  if (typeof value.tailscale?.nodeId !== 'string' || typeof value.tailscale.dnsName !== 'string') return false;
  try { validateSshTarget(value.sshTarget); } catch { return false; }
  return true;
}

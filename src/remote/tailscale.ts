/** Machines Tailscale knows about, as candidates for ClikCode Remote.
 *
 * Tailscale is the convenience layer, not the transport: it lists the
 * user's machines (`tailscale status --json`) and gives each a MagicDNS
 * name, which plain ssh then connects to (Tailscale SSH, where it is on,
 * needs no keys). A machine Tailscale does not know is added by address.
 *
 * Only machines that are the user's own are offered: owned by the same
 * Tailscale login as this one (not shared in from someone else), a desktop
 * OS ClikCode runs on, seen in the last 30 days, and one row per machine --
 * a machine re-added to the tailnet leaves its old node behind, offline,
 * under the same name. */
import { spawn } from 'node:child_process';
import type { RemoteMachine } from './machines.js';
import { targetHost } from './shell.js';
import { failureText } from '../harness/protocol/stderr-line.js';

export const DISCOVERY_RECENT_MS = 30 * 24 * 60 * 60 * 1000;

/** The part of a node in `tailscale status --json` this reads. */
interface TailscaleNode {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  OS?: string;
  UserID?: number;
  Online?: boolean;
  LastSeen?: string;
  /** Shared into this tailnet from another one. */
  ShareeNode?: boolean | null;
  TailscaleIPs?: string[];
}

export interface TailscaleStatus {
  BackendState?: string;
  Self?: TailscaleNode;
  Peer?: Record<string, TailscaleNode>;
  User?: Record<string, { LoginName?: string; DisplayName?: string }>;
}

export interface DiscoveredMachine {
  /** Tailscale's stable node id. */
  nodeId: string;
  /** What the user calls it: the MagicDNS label (`imac`), else the host name. */
  name: string;
  /** The MagicDNS name, without its trailing dot: what ssh connects to. */
  dnsName?: string;
  hostName: string;
  os: 'linux' | 'macOS' | 'windows';
  online: boolean;
  /** When it was last seen (absent while online). */
  lastSeen?: string;
}

/** Tailnet nodes not already in the saved machine list. */
export function notYetAdded(discovered: readonly DiscoveredMachine[], machines: readonly RemoteMachine[]): DiscoveredMachine[] {
  const hosts = new Set(machines.map((machine) => targetHost(machine.sshTarget).toLowerCase()));
  const nodes = new Set(machines.flatMap((machine) => (machine.tailscale ? [machine.tailscale.nodeId] : [])));
  return discovered.filter((machine) => !nodes.has(machine.nodeId)
    && !(machine.dnsName && hosts.has(machine.dnsName.toLowerCase()))
    && !hosts.has(machine.name.toLowerCase()));
}

const DESKTOP_OS: Readonly<Record<string, DiscoveredMachine['os']>> = { linux: 'linux', macos: 'macOS', windows: 'windows' };

/** A machine's name with the differences between two nodes of it taken out:
 * case, punctuation, apostrophes (`Justin’s-iMac`, `justins-imac`). */
export function baseMachineName(name: string): string {
  return name.toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const lastSeenMs = (node: TailscaleNode): number => {
  const at = node.LastSeen ? Date.parse(node.LastSeen) : Number.NaN;
  // Tailscale writes the zero time for a node that is online now.
  return Number.isNaN(at) || at < 0 ? -Infinity : at;
};

/** The candidates in `status`, newest first by name. Pure: tested on fixtures. */
export function discoverMachines(status: TailscaleStatus, now = Date.now()): DiscoveredMachine[] {
  const self = status.Self;
  if (!self || self.UserID === undefined) return [];
  const own = Object.values(status.Peer ?? {}).filter((node) => node.UserID === self.UserID && !node.ShareeNode);
  const candidates = own.flatMap((node): DiscoveredMachine[] => {
    const os = DESKTOP_OS[(node.OS ?? '').toLowerCase()];
    if (!os || !node.ID) return [];
    const online = node.Online === true;
    const seen = lastSeenMs(node);
    if (!online && !(now - seen < DISCOVERY_RECENT_MS)) return [];
    const dnsName = node.DNSName?.replace(/\.$/, '') || undefined;
    const label = dnsName?.split('.')[0];
    const hostName = node.HostName ?? label ?? node.ID;
    return [{
      nodeId: node.ID, name: label || hostName, ...(dnsName ? { dnsName } : {}), hostName, os, online,
      ...(Number.isFinite(seen) ? { lastSeen: new Date(seen).toISOString() } : {}),
    }];
  });
  // One row per machine: an offline node with the same base name (by host
  // name or by MagicDNS label) as one already kept -- online, or seen more
  // recently -- is that machine's old node.
  const rank = (machine: DiscoveredMachine): number => (machine.online ? Infinity : machine.lastSeen ? Date.parse(machine.lastSeen) : -Infinity);
  const kept: DiscoveredMachine[] = [];
  for (const machine of [...candidates].sort((left, right) => rank(right) - rank(left))) {
    const keys = new Set([baseMachineName(machine.hostName), baseMachineName(machine.name)]);
    const duplicate = kept.some((other) => [baseMachineName(other.hostName), baseMachineName(other.name)].some((key) => keys.has(key)));
    // Two online nodes with one name are two machines; an offline one is the old node of one.
    if (!duplicate || machine.online) kept.push(machine);
  }
  return kept.sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name));
}

/** `tailscale status --json`, or why it could not be read. */
export function readTailscaleStatus(timeoutMs = 5000): Promise<{ status?: TailscaleStatus; error?: string }> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn('tailscale', ['status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ error: error.code === 'ENOENT' ? 'Tailscale is not installed here' : error.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        const status = JSON.parse(out) as TailscaleStatus;
        if (status.BackendState && status.BackendState !== 'Running') { resolve({ error: `Tailscale is ${status.BackendState.toLowerCase()}` }); return; }
        resolve({ status });
      } catch {
        resolve({ error: failureText(err) || `tailscale status exited ${code}` });
      }
    });
  });
}

/** The machines added to ClikCode Remote: `<state>/remote/machines.json`.
 *
 * A small file of its own, not part of the conversation state: it is read
 * when /remote or the board opens and written when a machine is added,
 * updated, forgotten, or reports its chats (kept as the offline cache).
 * Written with atomicWriteFile into a 0700 directory, the file 0600. It
 * holds no secrets -- an SSH target, names, versions and chat titles. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDirectory } from '../session/store/paths.js';
import { atomicWriteFile } from '../session/store/files.js';
import type { IdeConversation } from '../ide/protocol.js';

export interface RemoteMachine {
  /** ClikCode's own id for the record. */
  id: string;
  /** What it is called in /remote and on the board. */
  name: string;
  /** What ssh connects to: user@host, host, or an ~/.ssh/config alias. */
  sshTarget: string;
  /** Where it came from in Tailscale, when it did. */
  tailscale?: { nodeId: string; dnsName?: string };
  os?: string;
  addedAt: string;
  /** The ClikCode installed there, as its `remote-info` said after install. */
  installed?: { version: string; commit?: string; at: string };
  /** That machine's ClikCode installation id: the same machine however it
   * was reached (two Tailscale nodes, an alias and an address). */
  installationId?: string;
  /** Its install finished: until then it is not on the board. */
  ready?: boolean;
  /** Last time a connection to it answered. */
  lastSeen?: string;
  /** Its chats as last seen: what the board shows while it is offline. */
  chats?: IdeConversation[];
  /** Its bridge's commit differs from this machine's build. */
  needsUpdate?: boolean;
}

interface MachinesFile { version: 1; machines: RemoteMachine[] }

export function machinesPath(): string {
  return join(stateDirectory(), 'remote', 'machines.json');
}

export async function readMachines(): Promise<RemoteMachine[]> {
  try {
    const parsed = JSON.parse(await readFile(machinesPath(), 'utf8')) as Partial<MachinesFile>;
    return Array.isArray(parsed.machines) ? parsed.machines.filter((machine) => machine && typeof machine.id === 'string' && typeof machine.sshTarget === 'string') : [];
  } catch {
    return [];
  }
}

/** Writes are serialized within this process: the board's cache updates and
 * /remote's own changes never interleave a read-modify-write. */
let writing: Promise<unknown> = Promise.resolve();

/** Read, change, write -- one at a time. `change` returns the new list. */
export function updateMachines(change: (machines: RemoteMachine[]) => RemoteMachine[] | void, options: { durable?: boolean } = {}): Promise<RemoteMachine[]> {
  const next = writing.then(async () => {
    const machines = await readMachines();
    const changed = change(machines) ?? machines;
    await atomicWriteFile(machinesPath(), `${JSON.stringify({ version: 1, machines: changed } satisfies MachinesFile, null, 2)}\n`, options);
    return changed;
  });
  writing = next.catch(() => undefined);
  return next;
}

/** One machine's record changed in place (nothing, if it is gone). */
export function updateMachine(id: string, patch: (machine: RemoteMachine) => void, options: { durable?: boolean } = {}): Promise<RemoteMachine | undefined> {
  let found: RemoteMachine | undefined;
  return updateMachines((machines) => {
    found = machines.find((machine) => machine.id === id);
    if (found) patch(found);
  }, options).then(() => found);
}

export function newMachineRecord(input: Pick<RemoteMachine, 'name' | 'sshTarget'> & Partial<RemoteMachine>): RemoteMachine {
  return { id: randomUUID(), addedAt: new Date().toISOString(), ...input };
}

export function forgetMachine(id: string): Promise<RemoteMachine[]> {
  return updateMachines((machines) => machines.filter((machine) => machine.id !== id));
}

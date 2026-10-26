/** The machines added to ClikCode Remote: `<state>/remote/machines.json`.
 *
 * A small file of its own, not part of the conversation state: it is read
 * when /machine or the board opens and written when a machine is added,
 * updated, forgotten, or reports its chats (kept as the offline cache).
 * Written with atomicWriteFile into a 0700 directory, the file 0600. It
 * holds no secrets -- an SSH target, names, versions and chat titles. */
import { quiet } from '../runtime/lifecycle-log.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDirectory } from '../session/store/paths.js';
import { atomicWriteFile } from '../session/store/files.js';
import type { IdeConversation } from '../ide/protocol.js';

export interface RemoteMachine {
  /** ClikCode's own id for the record. */
  id: string;
  /** What it is called in /machine and on the board. */
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
  /** 'auto': ClikCode brings it to this build's commit by itself when it
   * differs (remote/updates.ts). 'ask': only when the user says so. A record
   * without the field is 'auto'. */
  updates?: UpdatePolicy;
  /** Why the last update of it failed; cleared by one that succeeds. */
  updateError?: string;
  /** 'peer': it added itself, by connecting to this machine (remote/peer.ts).
   * Its address follows what it says of itself; one the user added keeps the
   * address the user gave. */
  addedBy?: 'peer';
}

/** A machine the user removed: it does not add itself back by connecting
 * here (remote/peer.ts). Adding it again by hand clears it. */
export interface ForgottenMachine { installationId?: string; nodeId?: string; at: string }

export type UpdatePolicy = 'auto' | 'ask';

export function updatePolicy(machine: Pick<RemoteMachine, 'updates'>): UpdatePolicy {
  return machine.updates === 'ask' ? 'ask' : 'auto';
}

interface MachinesFile { version: 1; machines: RemoteMachine[]; forgotten?: ForgottenMachine[] }

export function machinesPath(): string {
  return join(stateDirectory(), 'remote', 'machines.json');
}

export async function readMachines(): Promise<RemoteMachine[]> {
  return (await readMachinesFile()).machines;
}

/** The machines the user removed (ForgottenMachine). */
export async function readForgotten(): Promise<ForgottenMachine[]> {
  return (await readMachinesFile()).forgotten;
}

async function readMachinesFile(): Promise<{ machines: RemoteMachine[]; forgotten: ForgottenMachine[] }> {
  try {
    const parsed = JSON.parse(await readFile(machinesPath(), 'utf8')) as Partial<MachinesFile>;
    return {
      machines: Array.isArray(parsed.machines) ? parsed.machines.filter((machine) => machine && typeof machine.id === 'string' && typeof machine.sshTarget === 'string') : [],
      forgotten: Array.isArray(parsed.forgotten) ? parsed.forgotten.filter((item) => item && (typeof item.installationId === 'string' || typeof item.nodeId === 'string')) : [],
    };
  } catch {
    return { machines: [], forgotten: [] };
  }
}

/** Whether `machine` is one the user removed. */
export function isForgotten(forgotten: readonly ForgottenMachine[], machine: { installationId?: string; nodeId?: string }): boolean {
  return forgotten.some((item) => (item.installationId !== undefined && item.installationId === machine.installationId)
    || (item.nodeId !== undefined && item.nodeId === machine.nodeId));
}

/** Writes are serialized within this process: the board's cache updates and
 * /machine's own changes never interleave a read-modify-write. */
let writing: Promise<unknown> = Promise.resolve();

/** Read, change, write -- one at a time. `change` returns the new list. */
export function updateMachines(
  change: (machines: RemoteMachine[], forgotten: readonly ForgottenMachine[]) => RemoteMachine[] | void,
  options: { durable?: boolean; forget?: RemoteMachine } = {},
): Promise<RemoteMachine[]> {
  const next = writing.then(async () => {
    const file = await readMachinesFile();
    const changed = change(file.machines, file.forgotten) ?? file.machines;
    // A machine listed is not a forgotten one: added again (by hand), it may
    // add itself back too.
    let forgotten = file.forgotten.filter((item) => !changed.some((machine) => isForgotten([item], { ...(machine.installationId ? { installationId: machine.installationId } : {}), ...(machine.tailscale ? { nodeId: machine.tailscale.nodeId } : {}) })));
    const gone = options.forget;
    if (gone && (gone.installationId || gone.tailscale)) {
      forgotten = [...forgotten, { ...(gone.installationId ? { installationId: gone.installationId } : {}), ...(gone.tailscale ? { nodeId: gone.tailscale.nodeId } : {}), at: new Date().toISOString() }];
    }
    const body: MachinesFile = { version: 1, machines: changed, ...(forgotten.length ? { forgotten } : {}) };
    await atomicWriteFile(machinesPath(), `${JSON.stringify(body, null, 2)}\n`, { ...(options.durable !== undefined ? { durable: options.durable } : {}) });
    return changed;
  });
  writing = next.catch(quiet('remote/machines'));
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
  return { id: randomUUID(), addedAt: new Date().toISOString(), updates: 'auto', ...input };
}

/** Removes a machine. `remember` (the user removed it): it does not add
 * itself back by connecting here (remote/peer.ts) until added again by hand. */
export async function forgetMachine(id: string, options: { remember?: boolean } = {}): Promise<RemoteMachine[]> {
  const gone = options.remember ? (await readMachines()).find((machine) => machine.id === id) : undefined;
  return updateMachines((machines) => machines.filter((machine) => machine.id !== id), gone ? { forget: gone } : {});
}

/** The machines screen in VS Code shares the CLI's SSH discovery and board
 * link, and its updates: a machine is kept at the commit of the ClikCode this
 * editor runs (its `remote-info`), by the machine's policy
 * (src/remote/updates.ts), and the Update action runs the same update. */
import { RemoteMachines, type LinkChannel, type MachineView } from '../../../src/remote/connection';
import { localMachineName } from '../../../src/remote/board-rows';
import type { InstallOutcome, InstallReporter } from '../../../src/remote/install';
import { readMachines } from '../../../src/remote/machines';
import { updateRemoteMachine } from '../../../src/remote/updates';
import { discoverMachines, notYetAdded, readTailscaleStatus } from '../../../src/remote/tailscale';
import type { IdeConversation } from './protocol';
import type { MachineUpdate } from './model/types';

export interface ListedMachine {
  id: string;
  name: string;
  state: 'local' | MachineView['state'] | 'available' | 'unavailable' | 'unsupported';
  chats: number;
  needsYou: number;
  /** A remote machine's ClikCode is another commit than this editor's. */
  needsUpdate?: boolean;
  /** It is being updated now. */
  updating?: boolean;
  /** Why its last update failed. */
  updateError?: string;
}

/** A machine's update state, as a listed machine carries it. */
export function updateFields(view: Pick<MachineView, 'needsUpdate' | 'updating' | 'updateError'>): Pick<ListedMachine, 'needsUpdate' | 'updating' | 'updateError'> {
  return {
    ...(view.needsUpdate ? { needsUpdate: true } : {}),
    ...(view.updating ? { updating: true } : {}),
    ...(view.needsUpdate && view.updateError ? { updateError: view.updateError } : {}),
  };
}

/** A machine's update state, as the chat's model carries it (the composer's chip). */
export function machineUpdateOf(view: Pick<MachineView, 'needsUpdate' | 'updating' | 'updateError'> | undefined): MachineUpdate | undefined {
  if (!view) return undefined;
  if (view.updating) return { state: 'updating' };
  if (!view.needsUpdate) return undefined;
  return view.updateError ? { state: 'failed', error: view.updateError } : { state: 'needs' };
}

class RemoteDirectory {
  private links?: RemoteMachines;
  private opening?: Promise<RemoteMachines>;
  private listeners = new Set<() => void>();
  /** Updates run from the editor's Update action, by machine. */
  private updating = new Set<string>();
  private commitOf: () => Promise<string | undefined> = () => Promise.resolve(undefined);
  private commit?: Promise<string | undefined>;

  /** Where the commit of the ClikCode this editor runs comes from. */
  configureLocalCommit(read: () => Promise<string | undefined>): void {
    this.commitOf = read;
    this.commit = undefined;
  }

  /** That commit: what other machines are kept at. Undefined when it has none. */
  localCommit(): Promise<string | undefined> {
    this.commit ??= this.commitOf().catch(() => undefined);
    return this.commit;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async ensure(): Promise<RemoteMachines> {
    if (this.links) return this.links;
    this.opening ??= this.localCommit().then((localCommit) => new RemoteMachines(localCommit ? { localCommit } : {}).open()).then((links) => {
      this.links = links;
      links.onChange(() => this.notify());
      if (!this.listeners.size) { this.links = undefined; void links.close(); }
      return links;
    }).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  watch(listener: () => void): () => void {
    const release = this.watchWith(listener);
    void this.ensure().then(() => listener()).catch(() => listener());
    return release;
  }

  /** Keeps the machines' connections open, if they are, until released
   * (the menu that opened them may close meanwhile). Opens none. */
  hold(): () => void {
    if (!this.links) return () => undefined;
    const keep = (): void => undefined;
    return this.watchWith(keep);
  }

  /** A chat channel on the connection the machine menu already has to a
   * machine (a move goes over it), or undefined when there is none open. */
  async channel(machineId: string): Promise<LinkChannel | undefined> {
    return this.links?.channel(machineId);
  }

  private watchWith(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      const links = this.links;
      this.links = undefined;
      void links?.close();
    };
  }

  async machines(localChats: readonly IdeConversation[], discover = false): Promise<ListedMachine[]> {
    const links = await this.ensure();
    const saved = await readMachines();
    const tailnet = discover ? await readTailscaleStatus() : {};
    const discovered = tailnet.status ? notYetAdded(discoverMachines(tailnet.status), saved.filter((machine) => machine.ready)) : [];
    return [
      { id: 'local', name: localMachineName(), state: 'local', chats: localChats.length, needsYou: localChats.filter((chat) => chat.needsYou).length },
      ...links.views().map((view): ListedMachine => ({
        id: view.machine.id, name: view.machine.name, state: view.state, chats: view.chats.length,
        needsYou: view.state === 'offline' ? 0 : view.chats.filter((chat) => chat.needsYou).length,
        ...updateFields({ ...view, updating: view.updating || this.updating.has(view.machine.id) }),
      })),
      ...discovered.map((machine): ListedMachine => ({
        id: `tailscale:${machine.nodeId}`, name: machine.name,
        state: machine.os === 'windows' ? 'unsupported' : machine.online ? 'available' : 'unavailable',
        chats: 0, needsYou: 0,
      })),
    ];
  }

  async refresh(): Promise<void> {
    await (await this.ensure()).refresh();
  }

  async conversations(machineId: string): Promise<IdeConversation[]> {
    return [...((await this.ensure()).views().find((view) => view.machine.id === machineId)?.chats ?? [])];
  }

  async machine(machineId: string): Promise<MachineView | undefined> {
    const connected = this.links?.views().find((view) => view.machine.id === machineId);
    if (connected) return connected;
    const machine = (await readMachines()).find((item) => item.id === machineId && item.ready);
    return machine ? {
      machine, state: 'connecting', needsUpdate: Boolean(machine.needsUpdate), chats: machine.chats ?? [],
      ...(this.updating.has(machine.id) ? { updating: true } : {}), ...(machine.updateError ? { updateError: machine.updateError } : {}),
    } : undefined;
  }

  /** Updates a machine's ClikCode over SSH to this editor's commit (GitHub
   * main when it has none), then connects to it again. */
  async update(machineId: string, reporter: InstallReporter): Promise<InstallOutcome> {
    const machine = (await readMachines()).find((item) => item.id === machineId && item.ready);
    if (!machine) throw new Error('That machine is no longer added.');
    if (this.updating.has(machineId)) throw new Error(`ClikCode on ${machine.name} is already being updated.`);
    const commit = await this.localCommit();
    this.updating.add(machineId);
    this.notify();
    try {
      const outcome = await updateRemoteMachine(machine, reporter, commit ? { commit } : {});
      const view = this.links?.views().find((item) => item.machine.id === machineId);
      if (view) {
        if (outcome.ok) { view.updateError = undefined; delete view.machine.updateError; } else view.updateError = `${outcome.step}: ${outcome.message}`;
      }
      if (outcome.ok) this.links?.reconnect(machineId);
      return outcome;
    } finally {
      this.updating.delete(machineId);
      this.notify();
    }
  }
}

export const remoteDirectory = new RemoteDirectory();

/** The machines screen in VS Code shares the CLI's SSH discovery and board link. */
import { RemoteMachines, type MachineView } from '../../../src/remote/connection';
import { localMachineName } from '../../../src/remote/board-rows';
import { readMachines } from '../../../src/remote/machines';
import type { IdeConversation } from './protocol';

export interface ListedMachine {
  id: string;
  name: string;
  state: 'local' | MachineView['state'];
  chats: number;
  needsYou: number;
}

class RemoteDirectory {
  private links?: RemoteMachines;
  private opening?: Promise<RemoteMachines>;
  private listeners = new Set<() => void>();

  private async ensure(): Promise<RemoteMachines> {
    if (this.links) return this.links;
    this.opening ??= new RemoteMachines().open().then((links) => {
      this.links = links;
      links.onChange(() => { for (const listener of this.listeners) listener(); });
      if (!this.listeners.size) { this.links = undefined; void links.close(); }
      return links;
    }).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    void this.ensure().then(() => listener()).catch(() => listener());
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      const links = this.links;
      this.links = undefined;
      void links?.close();
    };
  }

  async machines(localChats: readonly IdeConversation[]): Promise<ListedMachine[]> {
    const links = await this.ensure();
    return [
      { id: 'local', name: localMachineName(), state: 'local', chats: localChats.length, needsYou: localChats.filter((chat) => chat.needsYou).length },
      ...links.views().map((view): ListedMachine => ({
        id: view.machine.id, name: view.machine.name, state: view.state, chats: view.chats.length,
        needsYou: view.state === 'offline' ? 0 : view.chats.filter((chat) => chat.needsYou).length,
      })),
    ];
  }

  async conversations(machineId: string): Promise<IdeConversation[]> {
    return [...((await this.ensure()).views().find((view) => view.machine.id === machineId)?.chats ?? [])];
  }

  async machine(machineId: string): Promise<MachineView | undefined> {
    const connected = this.links?.views().find((view) => view.machine.id === machineId);
    if (connected) return connected;
    const machine = (await readMachines()).find((item) => item.id === machineId && item.ready);
    return machine ? { machine, state: 'connecting', needsUpdate: Boolean(machine.needsUpdate), chats: machine.chats ?? [] } : undefined;
  }
}

export const remoteDirectory = new RemoteDirectory();

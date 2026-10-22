/** How a machine reads in the machine menus and on the composer's chip:
 * its state, its chats, and whether its ClikCode needs an update (another
 * commit than the one this editor runs; src/remote/updates.ts). Pure, so the
 * words are tested without a page. */
import type { ChatModel } from '../model';
import type { ListedMachine } from '../remote-directory';

type UpdateFields = Pick<ListedMachine, 'needsUpdate' | 'updating' | 'updateError'>;

/** A failure's words, short enough for a row; the whole of it is the row's title. */
const brief = (text: string, max = 90): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Its ClikCode's state, when that is not simply current. */
export function machineUpdateText(machine: UpdateFields): string | undefined {
  if (machine.updating) return 'updating ClikCode…';
  if (!machine.needsUpdate) return undefined;
  return machine.updateError ? `needs update · last update failed: ${brief(machine.updateError)}` : 'needs update';
}

/** A row's small print: current, state, chats, update. */
export function machineMeta(machine: ListedMachine, currentId: string): string {
  return [
    machine.id === currentId ? 'current' : undefined,
    machine.state, `${machine.chats} chats`,
    machine.needsYou ? `${machine.needsYou} need you` : undefined,
    machineUpdateText(machine),
  ].filter(Boolean).join(' · ');
}

/** A machine from the tailnet, not added yet: what choosing it does, or why it cannot be chosen. */
export function discoveredMeta(machine: ListedMachine): string {
  if (machine.state === 'available') return 'Connect · install from GitHub main';
  return machine.state === 'unsupported' ? 'Windows is not supported yet' : 'offline';
}

/** Whether the row offers Update: this computer always (as /update does);
 * another machine when its ClikCode needs one and it can be reached. */
export function offersUpdate(machine: ListedMachine): boolean {
  if (machine.id === 'local') return true;
  if (machine.id.startsWith('tailscale:') || machine.updating) return false;
  return Boolean(machine.needsUpdate) && machine.state === 'connected';
}

/** The composer's machine chip: its name, and its ClikCode's state when the
 * chat's machine is not on this editor's build; `update` when the chip
 * offers Update. */
export function machineChip(model: Pick<ChatModel, 'machine' | 'machineUpdate'>): { label: string; title: string; update: boolean } {
  const name = model.machine ?? 'This machine';
  const state = model.machineUpdate?.state;
  const said = state === 'updating' ? 'updating ClikCode…' : state === 'failed' ? 'update failed' : state === 'needs' ? 'needs update' : undefined;
  return {
    label: said ? `${name} · ${said}` : name,
    title: `Machine: ${name}${said ? ` (${said}${model.machineUpdate?.error ? `: ${model.machineUpdate.error}` : ''})` : ''}`,
    update: state === 'needs' || state === 'failed',
  };
}

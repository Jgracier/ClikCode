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

/** The classes a machine's rows are drawn in: three hues, none of them the green, yellow or red the list spends on a turn's
 * state, chosen from the machine's id so a machine keeps its colour when others are added or reordered. */
export const MACHINE_HUE_CLASSES = ['machine-hue-0', 'machine-hue-1', 'machine-hue-2'] as const;

export function machineHueClass(machineId: string): (typeof MACHINE_HUE_CLASSES)[number] {
  let sum = 0;
  for (const character of machineId) sum = (sum * 31 + character.charCodeAt(0)) >>> 0;
  return MACHINE_HUE_CLASSES[sum % MACHINE_HUE_CLASSES.length]!;
}

/** One other machine's chats in the history list: a section headed by its name, in its hue. */
export interface OtherMachineSection<Row> {
  machineId: string;
  title: string;
  hue: (typeof MACHINE_HUE_CLASSES)[number];
  /** Offline: its rows are the ones it had last time. */
  offline: boolean;
  rows: Row[];
}

/**
 * The sections for every machine but the one the list is showing: its name, its hue, its chats matching `matches`. A machine
 * with no chats, or none matching, adds no section. A tailnet machine not added yet is not a machine with chats. Pure.
 */
export function otherMachineSections<Row extends { id: string }>(
  machines: readonly Pick<ListedMachine, 'id' | 'name' | 'state'>[], showing: string,
  chatsOf: (machineId: string) => readonly Row[] | undefined, matches: (row: Row) => boolean,
): OtherMachineSection<Row>[] {
  const sections: OtherMachineSection<Row>[] = [];
  for (const machine of machines) {
    if (machine.id === showing || machine.id.startsWith('tailscale:')) continue;
    const rows = (chatsOf(machine.id) ?? []).filter(matches);
    if (!rows.length) continue;
    sections.push({ machineId: machine.id, title: machine.name, hue: machineHueClass(machine.id), offline: machine.state === 'offline', rows });
  }
  return sections;
}

/** The other machines' chats as conversation-board rows.
 *
 * The same words as this machine's rows (conversationState: working,
 * stalled, needs you, back at, or when it last changed), under a section per
 * machine below this machine's own. A chat that needs the user, on any
 * machine, is pinned in "Needs you" at the top. An offline machine keeps the
 * rows it had last time, dimmed, and its heading says since when.
 *
 * Rows are values, rebuilt only when something changed, and a machine's
 * rows stay in its own section -- one machine's list changing never moves
 * another's, or this machine's. */
import chalk from 'chalk';
import { hostname } from 'node:os';
import type { PickerOption } from '../harness/prompter.js';
import type { IdeConversation } from '../ide/protocol.js';
import { conversationState } from '../session/conversation-state.js';
import type { MachineView } from './connection.js';

export const REMOTE_VALUE_PREFIX = 'remote:';

/** A remote row's value: which machine, which chat. */
export function remoteRowValue(machineId: string, chatId: string): string {
  return `${REMOTE_VALUE_PREFIX}${machineId}\u0000${chatId}`;
}

export function isRemoteRowValue(value: string): boolean {
  return value.startsWith(REMOTE_VALUE_PREFIX);
}

export function parseRemoteRowValue(value: string): { machineId: string; chatId: string } | undefined {
  if (!isRemoteRowValue(value)) return undefined;
  const separator = value.indexOf('\0', REMOTE_VALUE_PREFIX.length);
  if (separator < 0) return undefined;
  return { machineId: value.slice(REMOTE_VALUE_PREFIX.length, separator), chatId: value.slice(separator + 1) };
}

/** This machine's name on the board. */
export function localMachineName(): string {
  try { return hostname().split('.')[0] || 'This machine'; } catch { return 'This machine'; }
}

/** One remote chat as a row, worded as conversationOption words a local one. */
export function remoteConversationOption(machine: MachineView, chat: IdeConversation, now: number): PickerOption<string> {
  const state = conversationState({
    updatedAt: chat.updatedAt,
    ...(chat.activity === 'working' && chat.turn ? { turn: chat.turn } : {}),
    ...(chat.needsYou ? { needsYou: true } : {}),
    ...(chat.resumeAt ? { resumeAt: chat.resumeAt } : {}),
  }, now);
  const offline = machine.state === 'offline';
  const activity = !offline && (state.kind === 'working' || state.kind === 'needs-you') ? state.kind : undefined;
  const text = state.text;
  const detail = [`· ${text}`, chat.preview].filter(Boolean).join(' · ');
  return {
    label: offline ? chalk.dim(chat.title) : chat.title,
    detail: offline ? chalk.dim(detail) : detail,
    ...(activity ? { activity } : {}),
    value: remoteRowValue(machine.machine.id, chat.id),
  };
}

/** The hues a machine's rows are drawn in: none of green, yellow or red, which the board spends on how long a turn has been quiet. */
const MACHINE_HUES = [chalk.cyan, chalk.magenta, chalk.blue] as const;

/** One machine's hue, the same every time: from its id, so it does not move when machines are added or reordered. */
export function machineHue(machineId: string): (text: string) => string {
  let sum = 0;
  for (const character of machineId) sum = (sum * 31 + character.charCodeAt(0)) >>> 0;
  return MACHINE_HUES[sum % MACHINE_HUES.length]!;
}

/**
 * Every other machine's chats, for the main conversation list: a section per machine, headed by its name in its hue, its rows
 * in the same hue, so a chat that lives elsewhere is told apart at a glance and a chat moved there is still in the list. An
 * offline machine keeps the rows it had last time, dimmed, and its heading says so. A machine with no chats adds nothing.
 * Pure.
 */
export function otherMachineRows(views: readonly MachineView[], now: number): PickerOption<string>[] {
  const rows: PickerOption<string>[] = [];
  for (const view of views) {
    if (!view.chats.length) continue;
    const hue = machineHue(view.machine.id);
    const offline = view.state === 'offline';
    const group = `${hue(view.machine.name)}${offline ? chalk.dim(' · offline, as last seen') : ''}`;
    for (const chat of view.chats) {
      const row = remoteConversationOption(view, chat, now);
      rows.push({ ...row, label: offline ? row.label : hue(row.label), group });
    }
  }
  return rows;
}

export function updateText(view: Pick<MachineView, 'needsUpdate' | 'updating' | 'updateError'>): string {
  if (view.updating) return ' · updating ClikCode…';
  if (!view.needsUpdate) return '';
  return view.updateError ? ` · ${chalk.yellow('update failed')} (/machine)` : ' · needs update (/machine)';
}

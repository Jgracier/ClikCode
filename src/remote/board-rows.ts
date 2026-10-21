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
import { conversationState, SECTION_TITLES, type ConversationSection } from '../session/conversation-state.js';
import { relativeTime } from '../harness/protocol/format.js';
import type { MachineView } from './connection.js';

export const REMOTE_VALUE_PREFIX = 'remote:';
export const NEEDS_YOU_GROUP = 'Needs you';

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
  const activity = !offline && (state.kind === 'working' || state.kind === 'stalled' || state.kind === 'needs-you') ? state.kind : undefined;
  const text = state.kind === 'stalled' ? chalk.yellow(state.text) : state.text;
  const detail = [`· ${text}`, chat.preview].filter(Boolean).join(' · ');
  return {
    label: offline ? chalk.dim(chat.title) : chat.title,
    detail: offline ? chalk.dim(detail) : detail,
    ...(activity ? { activity } : {}),
    value: remoteRowValue(machine.machine.id, chat.id),
  };
}

const SECTION_ORDER: readonly ConversationSection[] = ['working', 'active', 'past'];

/** A machine's heading: its name, and how it is when that is not simply connected. */
export function machineHeading(view: MachineView, now: number, section?: ConversationSection): string {
  const name = view.machine.name;
  if (view.state === 'offline') {
    const seen = view.machine.lastSeen ? `, last seen ${relativeTime(view.machine.lastSeen, now)}` : '';
    return chalk.dim(`${name} · offline${seen}`);
  }
  return `${name}${section ? ` · ${SECTION_TITLES[section]}` : ''}${updateText(view)}`;
}

/** How its ClikCode is, when that is not simply current. */
export function updateText(view: Pick<MachineView, 'needsUpdate' | 'updating' | 'updateError'>): string {
  if (view.updating) return ' · updating ClikCode…';
  if (!view.needsUpdate) return '';
  return view.updateError ? ` · ${chalk.yellow('update failed')} (/remote)` : ' · needs update (/remote)';
}

/** The board's rows with the other machines in: `local` is this machine's
 * rows (grouped Working/Recent/Older). With no machine added the list is
 * `local` unchanged. */
export function boardRowsWithMachines(
  local: readonly PickerOption<string>[], machines: readonly MachineView[], now = Date.now(), localName = localMachineName(),
): PickerOption<string>[] {
  if (!machines.length) return [...local];
  const pinned: PickerOption<string>[] = [];
  const own: PickerOption<string>[] = [];
  for (const option of local) {
    if (option.activity === 'needs-you') pinned.push({ ...option, group: NEEDS_YOU_GROUP, detail: `${option.detail ?? ''} · ${localName}` });
    else own.push({ ...option, group: `${localName} · ${option.group ?? SECTION_TITLES.active}` });
  }
  const remote: PickerOption<string>[] = [];
  for (const view of machines) {
    const chats = view.chats.map((chat) => ({ chat, option: remoteConversationOption(view, chat, now) }));
    const listed = chats.filter(({ chat }) => !(chat.needsYou && view.state !== 'offline'));
    for (const { option } of chats) {
      if (option.activity === 'needs-you') pinned.push({ ...option, group: NEEDS_YOU_GROUP, detail: `${option.detail ?? ''} · ${view.machine.name}` });
    }
    if (view.state === 'offline') {
      // One heading: the sections were how it was, not how it is.
      const heading = machineHeading(view, now);
      if (!listed.length) remote.push({ label: chalk.dim('No chats seen yet'), value: remoteRowValue(view.machine.id, ''), group: heading });
      for (const { option } of listed) remote.push({ ...option, group: heading });
      continue;
    }
    if (!listed.length) {
      remote.push({ label: chalk.dim(view.state === 'connecting' ? 'Connecting…' : 'No conversations yet'), value: remoteRowValue(view.machine.id, ''), group: machineHeading(view, now) });
      continue;
    }
    for (const section of SECTION_ORDER) {
      for (const { chat, option } of listed) {
        if ((chat.section ?? 'past') === section) remote.push({ ...option, group: machineHeading(view, now, section) });
      }
    }
  }
  return [...pinned, ...own, ...remote];
}

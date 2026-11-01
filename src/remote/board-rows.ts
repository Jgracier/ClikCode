/** The other machines' chats as conversation-board rows.
 *
 * The same words as this machine's rows (conversationState: working,
 * stalled, needs you, back at, or when it last changed), in the same
 * sections, ordered among this machine's own by when each last changed. A
 * chat that needs the user, on any machine, is first in its section. An
 * offline machine keeps the rows it had last time, dimmed. */
import chalk from 'chalk';
import { hostname } from 'node:os';
import type { PickerOption } from '../harness/prompter.js';
import type { IdeConversation } from '../ide/protocol.js';
import { conversationState, SECTION_TITLES, type ConversationSection } from '../session/conversation-state.js';
import { recencySection } from '../session/conversation-rows.js';
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

/** A row with what orders it among the others: the section it is in, whether it needs the user, and when it last changed. */
export interface RankedRow { option: PickerOption<string>; section: ConversationSection; needsYou: boolean; updatedAtMs: number }

/**
 * Every other machine's chats, ranked to sit among this machine's own in the main conversation list: the same sections
 * (Working, Recent, Older) by the same rules, in the machine's colour with its name on the row, so a chat that lives elsewhere
 * is told apart at a glance and a chat moved there is still where its last turn put it. An offline machine keeps the rows it
 * had last time, dimmed. Pure.
 */
export function otherMachineRows(views: readonly MachineView[], now: number): RankedRow[] {
  const rows: RankedRow[] = [];
  for (const view of views) {
    const hue = machineHue(view.machine.id);
    const offline = view.state === 'offline';
    for (const chat of view.chats) {
      const row = remoteConversationOption(view, chat, now);
      const updatedAtMs = Date.parse(chat.updatedAt);
      const section: ConversationSection = row.activity === 'working' ? 'working' : recencySection(Number.isFinite(updatedAtMs) ? updatedAtMs : undefined, now);
      const where = offline ? chalk.dim(`${view.machine.name} · offline`) : hue(view.machine.name);
      rows.push({
        option: { ...row, label: offline ? row.label : hue(row.label), detail: `· ${where} ${row.detail ?? ''}`.trimEnd() },
        section, needsYou: row.activity === 'needs-you' || chat.needsYou === true, updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
      });
    }
  }
  return rows;
}

const SECTION_ORDER: Readonly<Record<ConversationSection, number>> = { working: 0, active: 1, past: 2 };

/** This machine's rows and the others' in one list, ordered as conversationRows orders one machine's: section, then the ones that need the user, then newest first. Each row gets its section's title. */
export function mergeMachineRows(own: readonly RankedRow[], others: readonly RankedRow[]): PickerOption<string>[] {
  return [...own, ...others]
    .map((row, index) => ({ row, index }))
    // Stable for equal times: this machine's own rows (first in) keep their order.
    .sort((left, right) => SECTION_ORDER[left.row.section] - SECTION_ORDER[right.row.section]
      || Number(right.row.needsYou) - Number(left.row.needsYou) || right.row.updatedAtMs - left.row.updatedAtMs || left.index - right.index)
    .map(({ row }) => ({ ...row.option, group: SECTION_TITLES[row.section] }));
}

export function updateText(view: Pick<MachineView, 'needsUpdate' | 'updating' | 'updateError'>): string {
  if (view.updating) return ' · updating ClikCode…';
  if (!view.needsUpdate) return '';
  return view.updateError ? ` · ${chalk.yellow('update failed')} (/machine)` : ' · needs update (/machine)';
}

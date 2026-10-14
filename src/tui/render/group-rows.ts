/** A group's rows, in place: the header, and under it the items, each opened
 * to its detail where the reader opened it. Pure -- the same group data and
 * expansion state give the same rows live and when the conversation is
 * reopened or drawn again at another width. Every row carries a tag
 * (row-tags.ts) so a tap on it can be told which group and item it meant. */

import chalk from 'chalk';
import { agentTask, callDetail, AGENT_RESULT_LINES, DETAIL_DIFF_LINES } from '../../harness/protocol/call-groups.js';
import { TOOL_ROW_TEXT } from '../../harness/protocol/tool-category-style.js';
import { fileDiffRows } from '../../harness/protocol/activity-line.js';
import { visibleSlice } from './width.js';
import { wrapWords } from './wrap.js';
import { tagRow } from './row-tags.js';
import type { ActivityEntry } from './activity-log.js';

/** What the reader opened: the group itself, and which of its items. */
export type GroupOpenState = { open: boolean; items: ReadonlySet<string> };

/** The expansion state of every group, by group id. Kept apart from the rows
 * so a rewrite of the transcript (a toggle, a new width) reads it again. */
export class GroupExpansion {
  private readonly groups = new Map<string, { open: boolean; items: Set<string> }>();

  get(id: string): GroupOpenState { return this.groups.get(id) ?? { open: false, items: new Set() }; }

  isOpen(id: string): boolean { return this.groups.get(id)?.open ?? false; }

  /** Opens or minimises the group; returns whether it is open now. */
  toggleGroup(id: string): boolean {
    const state = this.groups.get(id) ?? { open: false, items: new Set<string>() };
    state.open = !state.open;
    this.groups.set(id, state);
    return state.open;
  }

  /** Opens or minimises one item; returns whether it is open now. */
  toggleItem(id: string, item: string): boolean {
    const state = this.groups.get(id) ?? { open: true, items: new Set<string>() };
    const now = !state.items.delete(item);
    if (now) state.items.add(item);
    this.groups.set(id, state);
    return now;
  }

  clear(): void { this.groups.clear(); }
}

/** An item's detail under its row: a call's full command wrapped to the
 * width, how it ended, and the tail of its output; a thought's text, dim
 * italic. Rows are not indented. */
export function itemDetailRows(entry: ActivityEntry, room: number): string[] {
  const { event, thought } = entry;
  const rows: string[] = [];
  if (thought) {
    if (thought.text) for (const row of wrapWords(thought.text.replace(/\s+/g, ' ').trim(), room)) rows.push(chalk.dim(chalk.italic(row)));
    return rows;
  }
  if (!event) {
    for (const row of wrapWords(entry.decision?.detail ?? '', room)) rows.push(chalk.dim(row));
    return rows;
  }
  const detail = callDetail(event);
  for (const row of wrapWords(detail.command, room)) rows.push(TOOL_ROW_TEXT(row));
  if (entry.decision?.detail && entry.decision.detail !== detail.command) for (const row of wrapWords(entry.decision.detail, room)) rows.push(chalk.dim(row));
  for (const arg of detail.args) for (const row of wrapWords(arg, room)) rows.push(chalk.dim(row));
  if (detail.outcome) rows.push(chalk.dim(detail.outcome));
  if (event.diff?.length) for (const row of fileDiffRows(event.diff, DETAIL_DIFF_LINES)) rows.push(visibleSlice(row.slice(4), room));
  if (detail.earlier > 0 && detail.output.length) rows.push(chalk.dim(`… ${detail.earlier} earlier line${detail.earlier === 1 ? '' : 's'}`));
  for (const row of detail.output) rows.push(chalk.dim(visibleSlice(row, room)));
  return rows;
}

export type GroupItemLine = { id: string; line: string; entry: ActivityEntry };

/** The open group: `header` (already styled and indented) and one row per
 * item under it, an opened item followed by its detail. */
export function openGroupRows(input: { id: string; header: string; items: readonly GroupItemLine[]; state: GroupOpenState; width: number }): string[] {
  const { id, header, items, state, width } = input;
  const rows = [tagRow(header, { group: id, item: '' })];
  const room = Math.max(1, width - 8);
  for (const item of items) {
    rows.push(tagRow(`    ${visibleSlice(item.line.trim(), Math.max(1, width - 4))}`, { group: id, item: item.id }));
    if (!state.items.has(item.id)) continue;
    for (const row of itemDetailRows(item.entry, room)) rows.push(tagRow(`        ${row}`, { group: id, item: item.id }));
  }
  return rows;
}

/** At most `max` rows: the header, `+N earlier`, and the newest of the rest. */
export function capOpenRows(rows: readonly string[], id: string, max: number): string[] {
  if (rows.length <= max) return [...rows];
  const keep = Math.max(1, max - 2);
  return [rows[0]!, tagRow(`    ${chalk.dim(`+${rows.length - 1 - keep} earlier`)}`, { group: id, item: '' }), ...rows.slice(rows.length - keep)];
}

/** A sub-agent's expansion under its row: the task it was given, the calls it
 * made (each a row of its own, one level in, that opens to its detail), and
 * what it answered -- only what the call and its calls carry. */
function agentDetailRows(input: { id: string; entry: ActivityEntry; children: readonly ActivityEntry[]; state: GroupOpenState; width: number }): string[] {
  const { id, entry, children, state, width } = input;
  const event = entry.event!;
  const rows: string[] = [];
  const room = Math.max(1, width - 8);
  const task = agentTask(event);
  if (task) {
    const wrapped = wrapWords(task, room);
    for (const row of wrapped.slice(0, 4)) rows.push(tagRow(`    ${chalk.dim(row)}`, { group: id, item: '' }));
    if (wrapped.length > 4) rows.push(tagRow(`    ${chalk.dim('…')}`, { group: id, item: '' }));
  }
  const earlier = (event.childTools ?? 0) - children.length;
  if (earlier > 0) rows.push(tagRow(`      ${chalk.dim(`+${earlier} earlier`)}`, { group: id, item: '' }));
  for (const [index, child] of children.entries()) {
    const childId = child.event?.id ?? `child#${index}`;
    rows.push(tagRow(`      ${visibleSlice((child.lines[0] ?? '').trim(), Math.max(1, width - 6))}`, { group: id, item: childId, depth: 1 }));
    if (!state.items.has(childId)) continue;
    for (const row of itemDetailRows(child, Math.max(1, width - 12))) rows.push(tagRow(`          ${row}`, { group: id, item: childId, depth: 1 }));
  }
  const output = event.output ?? [];
  const shown = output.slice(0, AGENT_RESULT_LINES);
  for (const row of shown) rows.push(tagRow(`    ${chalk.dim(visibleSlice(row, room))}`, { group: id, item: '' }));
  const more = output.length - shown.length + (event.outputOmitted ?? 0);
  if (more > 0) rows.push(tagRow(`    ${chalk.dim(`… ${more} more line${more === 1 ? '' : 's'}`)}`, { group: id, item: '' }));
  return rows;
}

/** A call that opens on its own: its rows (blank rows left as they are), each
 * tagged with the call's id; opened, its detail under them -- a sub-agent's
 * task, calls and result, any other call's command, arguments, diff and
 * output. The same rows live and reopened. */
export function soloRows(input: {
  id: string; lines: readonly string[]; entry: ActivityEntry; children: readonly ActivityEntry[]; state: GroupOpenState; width: number;
}): string[] {
  const { id, lines, entry, children, state, width } = input;
  const rows = lines.map((line) => (line.trim() ? tagRow(line, { group: id, item: '' }) : line));
  if (!state.open) return rows;
  if (entry.event?.agent) return [...rows, ...agentDetailRows({ id, entry, children, state, width })];
  for (const row of itemDetailRows(entry, Math.max(1, width - 8))) rows.push(tagRow(`    ${row}`, { group: id, item: '' }));
  return rows;
}

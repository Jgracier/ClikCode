/** The expansion panel of a group: its items one per row above the composer,
 * and the one tapped open shows its full command and the tail of its output
 * (or a thought's text) under its row. A band of the live region, rebuilt each
 * frame from the group's kept items, so nothing already in scrollback is
 * rewritten. Rows carry tags (row-tags.ts) so a tap on them can be told which
 * item it meant. */

import chalk from 'chalk';
import { callDetail, groupSummary, groupSummaryText } from '../../harness/protocol/call-groups.js';
import { TOOL_CATEGORY_STYLE, TOOL_ROW_TEXT } from '../../harness/protocol/tool-category-style.js';
import { fileDiffRows } from '../../harness/protocol/activity-line.js';
import { visibleSlice } from './width.js';
import { wrapWords } from './wrap.js';
import { tagRow } from './row-tags.js';
import type { GroupData } from './call-groups.js';

export type GroupPanelState = {
  id: string;
  /** Items opened inline. */
  open: Set<string>;
  /** The item opened last: the window shows it. */
  anchor?: string;
  /** First body row shown, once the window has been paged by a tap. */
  start?: number;
  /** Rows a page moves, as of the last frame. */
  step?: number;
};

/** The tag items of the panel's own controls. */
export const PANEL_CLOSE = '';
export const PANEL_EARLIER = '@earlier';
export const PANEL_LATER = '@later';

type BodyRow = { text: string; item: string };

/** The panel's rows, at most `budget` of them (header included). `state`
 * receives the window it drew, so a tap on `+N earlier` knows how far to page. */
export function groupPanelRows(data: GroupData, state: GroupPanelState, width: number, budget: number): string[] {
  const summary = groupSummary(data.items.map((item) => ({ id: item.id, ...(item.entry.event ? { event: item.entry.event } : {}), ...(item.entry.thought ? { thought: item.entry.thought } : {}) })), data.running);
  const style = TOOL_CATEGORY_STYLE.run;
  const header = tagRow(
    visibleSlice(`  ${style.paint(style.glyph)} ${TOOL_ROW_TEXT(groupSummaryText(summary) || 'Details')} ${chalk.dim('· tap or Esc to close')}`, width),
    { kind: 'gp', group: data.id, item: PANEL_CLOSE },
  );
  const body: BodyRow[] = [];
  const room = Math.max(1, width - 6);
  for (const item of data.items) {
    const line = item.entry.lines[0]?.trim() ?? '';
    body.push({ text: `    ${visibleSlice(line, Math.max(1, width - 4))}`, item: item.id });
    if (!state.open.has(item.id)) continue;
    const { event, thought } = item.entry;
    const add = (text: string): void => { body.push({ text: visibleSlice(`      ${text}`, width), item: item.id }); };
    if (thought) {
      if (thought.text) for (const row of wrapWords(thought.text.replace(/\s+/g, ' ').trim(), room)) add(chalk.dim(chalk.italic(row)));
      continue;
    }
    if (!event) continue;
    const detail = callDetail(event);
    for (const row of wrapWords(detail.command, room)) add(TOOL_ROW_TEXT(row));
    if (detail.outcome) add(chalk.dim(detail.outcome));
    if (event.diff?.length) for (const row of fileDiffRows(event.diff, 12)) add(row.trim());
    if (detail.earlier > 0 && detail.output.length) add(chalk.dim(`… ${detail.earlier} earlier line${detail.earlier === 1 ? '' : 's'}`));
    for (const row of detail.output) add(chalk.dim(row));
  }
  const space = Math.max(1, budget - 1);
  if (body.length <= space) {
    state.start = 0;
    state.step = space;
    return [header, ...body.map((row) => tagRow(row.text, { kind: 'gp', group: data.id, item: row.item }))];
  }
  const anchorAt = state.anchor === undefined ? -1 : body.findIndex((row) => row.item === state.anchor);
  let start = state.start ?? (anchorAt >= 0 ? anchorAt : body.length - space);
  start = Math.max(0, Math.min(start, body.length - Math.max(1, space - 1)));
  const earlier = start > 0;
  const slots = space - (earlier ? 1 : 0);
  const more = start + slots < body.length;
  const shown = body.slice(start, start + slots - (more ? 1 : 0));
  state.start = start;
  state.step = Math.max(1, shown.length);
  const tag = (text: string, item: string): string => tagRow(visibleSlice(text, width), { kind: 'gp', group: data.id, item });
  return [
    header,
    ...(earlier ? [tag(`    ${chalk.dim(`+${start} earlier`)}`, PANEL_EARLIER)] : []),
    ...shown.map((row) => tag(row.text, row.item)),
    ...(more ? [tag(`    ${chalk.dim(`+${body.length - start - shown.length} more`)}`, PANEL_LATER)] : []),
  ];
}

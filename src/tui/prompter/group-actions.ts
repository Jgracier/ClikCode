/** Opening and minimising a group, in place, from a tap or from Ctrl+O.
 *
 * The group's rows grow where they are (render/group-rows.ts reads the
 * expansion state from the prompter). A group still running is drawn from the
 * live region each frame, so a toggle is only a repaint. A settled group's rows
 * are retired, so the transcript is written again from its source -- the path
 * a change of width takes -- and the viewport is then anchored on the row that
 * was tapped, so it stays on the same screen row. */
import { parseTag, type RowTag } from '../render/row-tags.js';
import type { TerminalHarnessPrompter } from '../prompter.js';

/** What a toggle asks of the rewritten transcript. */
export type GroupAnchor = {
  group: string; item: string;
  /** The screen row the tag's first line should land on. */
  row: number;
  /** Move the row up as far as needed for the group/item's rows to fit under it. */
  fit: boolean;
};

/** The anchor, found in the rewritten rows: the line, and how many rows belong to it. */
export type AnchorTarget = { line: number; height: number; row: number; fit: boolean };

/** The raw tag of conversation line `line`: a kept transcript row's, or a
 * live row's from the last frame. */
function tagAt(p: TerminalHarnessPrompter, line: number): string | undefined {
  const end = p.alternateTrimmed + p.alternateTranscript.length;
  if (line < end) return p.lineTags.get(line);
  const extra = p.viewExtra;
  const index = line - end;
  return index < extra.rows.length ? extra.tags[index] : p.frameLayout.tags[index - extra.rows.length];
}

const belongs = (tag: RowTag | undefined, group: string, item: string): boolean =>
  tag !== undefined && tag.group === group && (item === '' || tag.item === item);

/** The lines of the kept transcript that carry this group's (or item's) tag, in order. */
function linesOf(p: TerminalHarnessPrompter, group: string, item: string): number[] {
  const lines: number[] = [];
  for (const [line, raw] of p.lineTags) if (line >= p.alternateTrimmed && belongs(parseTag(raw), group, item)) lines.push(line);
  return lines.sort((a, b) => a - b);
}

/** The screen row a transcript line is on now (negative: above the screen). */
export function screenRowOfLine(p: TerminalHarnessPrompter, line: number): number {
  const length = p.alternateTranscript.length + p.viewExtra.rows.length;
  return line - p.alternateTrimmed - (length - p.alternateAbove - p.alternateScrollback);
}

/** Whether nothing but blank rows follows the group's last row in the transcript. */
function groupIsLast(p: TerminalHarnessPrompter, group: string): boolean {
  const last = linesOf(p, group, '').pop();
  if (last === undefined) return false;
  for (let index = last - p.alternateTrimmed + 1; index < p.alternateTranscript.length; index += 1) {
    if (p.alternateTranscript[index]!.trim()) return false;
  }
  return true;
}

/** A settled group's toggle: write the transcript again, and say where the
 * row it began on must land. `place` decides the row from the first line of
 * the tag; no anchor when the reader is following the bottom and the group is
 * the last thing there. */
function rewriteInPlace(p: TerminalHarnessPrompter, group: string, item: string, place: (first: number | undefined, above: number) => number | undefined, fit: boolean): void {
  const first = linesOf(p, group, item)[0];
  const follow = p.alternateScrollback === 0 && groupIsLast(p, group);
  const row = follow ? undefined : place(first, p.alternateAbove);
  p.groupAnchor = row === undefined ? undefined : { group, item, row, fit };
  p.emitted.requestReseed();
}

/** A tap on conversation line `line`: on a group's header it opens or
 * minimises the group; on an item's row (or its detail) it opens or
 * minimises the item. True when the tap meant one of these. */
export function tapGroupRow(this: TerminalHarnessPrompter, line: number): boolean {
  const tag = parseTag(Number.isFinite(line) ? tagAt(this, line) : undefined);
  if (!tag || !this.callGroups.get(tag.group)) return false;
  const settled = line < this.alternateTrimmed + this.alternateTranscript.length;
  // Where the row stood before: its own first line, so a tap on an opened
  // item's detail still leaves the item's row where it was.
  const opening = tag.item ? !this.groupExpansion.get(tag.group).items.has(tag.item) : !this.groupExpansion.isOpen(tag.group);
  if (settled) {
    rewriteInPlace(this, tag.group, tag.item, (first, above) => {
      const row = screenRowOfLine(this, first ?? line);
      return Math.max(0, Math.min(row, above - 1));
    }, opening);
  }
  if (tag.item) this.groupExpansion.toggleItem(tag.group, tag.item);
  else this.groupExpansion.toggleGroup(tag.group);
  this.redrawSelection();
  return true;
}

/** Ctrl+O: the latest group (the live one while it runs, else the last settled)
 * opens or minimises where it is, and is brought into view only if it was off
 * screen. */
export function toggleLatestGroup(this: TerminalHarnessPrompter): boolean {
  const latest = this.callGroups.latest();
  if (!latest) return false;
  const opening = !this.groupExpansion.isOpen(latest.id);
  const first = linesOf(this, latest.id, '')[0];
  if (first === undefined) {
    // Still in the live region, which is not drawn while the reader is scrolled back.
    this.alternateScrollback = 0;
  } else {
    rewriteInPlace(this, latest.id, '', (line, above) => {
      const row = screenRowOfLine(this, line ?? first);
      if (row >= 0 && row < above) return row;
      return row < 0 ? 0 : above - 1;
    }, opening);
  }
  this.groupExpansion.toggleGroup(latest.id);
  this.redrawSelection();
  return true;
}

/** The scrollback that puts the anchored line on its screen row, or undefined
 * when the line is no longer in the transcript. `fit` moves the row up as far
 * as the rows that belong to it need, never past the top of the screen. */
export function anchoredScrollback(target: AnchorTarget, view: { length: number; trimmed: number; above: number }): number | undefined {
  const index = target.line - view.trimmed;
  if (index < 0 || index >= view.length) return undefined;
  const wanted = target.fit ? Math.min(target.row, view.above - target.height) : target.row;
  const row = Math.max(0, Math.min(wanted, view.above - 1));
  return Math.max(0, view.length - view.above - (index - row));
}

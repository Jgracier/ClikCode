/** Opening, closing and paging a group's expansion panel, from a tap or from
 * the keyboard (render/group-panel.ts draws it, render/call-groups.ts holds
 * the data). */
import { PANEL_CLOSE, PANEL_EARLIER, PANEL_LATER } from '../render/group-panel.js';
import { parseTag } from '../render/row-tags.js';
import type { TerminalHarnessPrompter } from '../prompter.js';

/** The raw tag of conversation line `line`: a kept transcript row's, or a
 * live row's from the last frame. */
function tagAt(p: TerminalHarnessPrompter, line: number): string | undefined {
  const end = p.alternateTrimmed + p.alternateTranscript.length;
  return line < end ? p.lineTags.get(line) : p.frameLayout.tags[line - end];
}

/** Ctrl+O: the latest group's panel (the live one while it runs), or close the one that is open. */
export function toggleGroupPanel(this: TerminalHarnessPrompter): boolean {
  if (this.groupPanel) { this.closeGroupPanel(); return true; }
  const latest = this.callGroups.latest();
  if (!latest) return false;
  this.groupPanel = { id: latest.id, open: new Set() };
  this.redrawSelection();
  return true;
}

/** Whether a panel was open. */
export function closeGroupPanel(this: TerminalHarnessPrompter): boolean {
  if (!this.groupPanel) return false;
  this.groupPanel = undefined;
  this.redrawSelection();
  return true;
}

/** A tap on conversation line `line`: on a group's row it opens the panel; on
 * a row of the panel it opens or closes an item, pages, or closes. True when
 * the tap meant one of these. */
export function tapGroupRow(this: TerminalHarnessPrompter, line: number): boolean {
  const tag = parseTag(Number.isFinite(line) ? tagAt(this, line) : undefined);
  if (!tag || !this.callGroups.get(tag.group)) return false;
  const panel = this.groupPanel;
  if (tag.kind === 'g') {
    if (panel?.id === tag.group && !tag.item) { this.groupPanel = undefined; }
    else if (panel?.id === tag.group) toggleItem(panel, tag.item);
    else this.groupPanel = { id: tag.group, open: new Set(tag.item ? [tag.item] : []), ...(tag.item ? { anchor: tag.item } : {}) };
  } else if (panel?.id === tag.group) {
    if (tag.item === PANEL_CLOSE) this.groupPanel = undefined;
    else if (tag.item === PANEL_EARLIER) panel.start = Math.max(0, (panel.start ?? 0) - (panel.step ?? 1));
    else if (tag.item === PANEL_LATER) panel.start = (panel.start ?? 0) + (panel.step ?? 1);
    else toggleItem(panel, tag.item);
  } else return false;
  this.redrawSelection();
  return true;
}

function toggleItem(panel: NonNullable<TerminalHarnessPrompter['groupPanel']>, item: string): void {
  if (panel.open.delete(item)) return;
  panel.open.add(item);
  panel.anchor = item;
  delete panel.start;
}

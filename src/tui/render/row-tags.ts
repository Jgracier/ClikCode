/** Which group and item a conversation row belongs to, carried beside the
 * text rather than in it.
 *
 * A row is built with a private-use marker in front (tagRow) and the marker is
 * taken off, once, where the frame is assembled (extractTags): the rows that
 * reach scrollback, the selection and the clipboard are clean, and the frame
 * keeps a map from line to tag for hit-testing a tap. */

const OPEN = '\uE000';
const CLOSE = '\uE001';

/** `group`: a group's id, or the id of a call that is expandable on its own (a
 * lone call, a sub-agent). `item`: empty for the row itself, else the item
 * (a group's call, a sub-agent's child call) opened under it. `depth`: how far
 * in the row is drawn, 0 for the row of the group or call. */
export type RowTag = { group: string; item: string; depth?: number };

/** A conversation row of a group (`item` empty: its header row). */
export function tagRow(row: string, tag: RowTag): string {
  return `${OPEN}g:${encodeURIComponent(tag.group)}|${encodeURIComponent(tag.item)}${tag.depth ? `|${tag.depth}` : ''}${CLOSE}${row}`;
}

export function parseTag(raw: string | undefined): RowTag | undefined {
  const match = raw ? /^g:([^|]*)\|([^|]*)(?:\|(\d+))?$/.exec(raw) : null;
  if (!match) return undefined;
  try {
    return { group: decodeURIComponent(match[1]!), item: decodeURIComponent(match[2]!), ...(match[3] ? { depth: Number(match[3]) } : {}) };
  } catch {
    return undefined;
  }
}

/** The rows without their markers, and each row's raw tag. */
export function extractTags(rows: readonly string[]): { rows: string[]; tags: Array<string | undefined> } {
  const tags: Array<string | undefined> = [];
  const clean = rows.map((row) => {
    if (!row.startsWith(OPEN)) { tags.push(undefined); return row; }
    const end = row.indexOf(CLOSE);
    if (end < 0) { tags.push(undefined); return row; }
    tags.push(row.slice(1, end));
    return row.slice(end + 1);
  });
  return { rows: clean, tags };
}

/** Which group and item a conversation row belongs to, carried beside the
 * text rather than in it.
 *
 * A row is built with a private-use marker in front (tagRow) and the marker is
 * taken off, once, where the frame is assembled (extractTags): the rows that
 * reach scrollback, the selection and the clipboard are clean, and the frame
 * keeps a map from line to tag for hit-testing a tap. */

const OPEN = '\uE000';
const CLOSE = '\uE001';

export type RowTag = { kind: 'g' | 'gp'; group: string; item: string };

/** `g`: a conversation row of a group (a tap opens it). `gp`: a row of the open panel. */
export function tagRow(row: string, tag: RowTag): string {
  return `${OPEN}${tag.kind}:${encodeURIComponent(tag.group)}|${encodeURIComponent(tag.item)}${CLOSE}${row}`;
}

export function parseTag(raw: string | undefined): RowTag | undefined {
  const match = raw ? /^(gp?):([^|]*)\|(.*)$/.exec(raw) : null;
  if (!match) return undefined;
  try {
    return { kind: match[1] as RowTag['kind'], group: decodeURIComponent(match[2]!), item: decodeURIComponent(match[3]!) };
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

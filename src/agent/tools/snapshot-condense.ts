/** Makes a page snapshot shorter without losing what can be acted on. A signup or key page is mostly navigation, repeated links
 * and marketing text around one small form, and each extra line costs every call that reads the page. What is cut: a link that
 * repeats another's name and address, the tail of a long text line, and the tail of a long list, menu or table (its form controls
 * and buttons stay, with their refs). Forms and buttons are never what is left out. */
const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Controls and headings: what a page is for. Kept when anything around them is cut. */
export const ACTIONABLE = /^\s*- (?:textbox|searchbox|button|checkbox|radio|combobox|switch|slider|spinbutton|heading|tab|menuitemcheckbox|menuitemradio|option|form|dialog|alert|alertdialog)\b/;
const CONTAINER = /^\s*- (?:list|menu|table|grid|tree|feed|rowgroup|region|article|navigation)\b/;
const LINK = /^(\s*)- link "(.*)" \[ref=[\w]+\]/;
const SECTION_LINES = 30;
const SECTION_KEEP = 12;
const TEXT_MAX = 200;

/** The lines of the block that starts at `from` (the line and everything deeper under it). */
const blockEnd = (lines: readonly string[], from: number): number => { let at = from + 1; while (at < lines.length && (lines[at]!.trim() === '' || indentOf(lines[at]!) > indentOf(lines[from]!))) at++; return at; };

/** A link whose name and address a link before it already had does the same thing: left out, counted. An emptied wrapper goes with it. */
export function dedupeLinks(lines: readonly string[]): { lines: string[]; removed: number } {
  const seen = new Set<string>();
  const out: string[] = [];
  let removed = 0;
  for (let at = 0; at < lines.length;) {
    const match = LINK.exec(lines[at]!);
    if (!match) { out.push(lines[at]!); at++; continue; }
    const end = blockEnd(lines, at);
    const url = lines.slice(at + 1, end).find(line => /^\s*- \/url: /.test(line))?.trim();
    const key = url ? `${match[2]}\u0000${url}` : undefined;
    if (key && end - at <= 3 && seen.has(key)) { removed++; at = end; continue; }
    if (key) seen.add(key);
    out.push(...lines.slice(at, end)); at = end;
  }
  // A wrapper (listitem, generic) that held only a removed link is empty now: drop it, and so on upwards.
  if (removed) for (let pass = 0; pass < 6; pass++) {
    const before = out.length;
    for (let at = out.length - 1; at >= 0; at--) {
      const line = out[at]!;
      const next = out[at + 1];
      if (/^\s*- (?:listitem|generic|group)\b[^:]*:$/.test(line) && !/\[active\]/.test(line) && (next === undefined || indentOf(next) <= indentOf(line))) out.splice(at, 1);
    }
    if (out.length === before) break;
  }
  return { lines: out, removed };
}

/** A paragraph or text line over 200 characters ends there, saying how much was cut. */
export function shortenText(lines: readonly string[]): string[] {
  return lines.map(line => {
    const match = /^(\s*- (?:paragraph|text|generic|blockquote|cell|listitem|caption|code|emphasis|strong)\b[^:]*): (.+)$/.exec(line);
    return match && match[2]!.length > TEXT_MAX + 40 ? `${match[1]}: ${match[2]!.slice(0, TEXT_MAX)}… (${match[2]!.length - TEXT_MAX} more characters)` : line;
  });
}

/** A list, menu, table or region over 30 lines keeps its first 12 and every control and heading in it (with the lines they sit under). */
export function capSections(lines: readonly string[]): { lines: string[]; cut: number } {
  const out: string[] = [];
  let cut = 0;
  for (let at = 0; at < lines.length;) {
    const end = CONTAINER.test(lines[at]!) ? blockEnd(lines, at) : at + 1;
    if (end - at <= SECTION_LINES) { out.push(lines[at]!); at++; continue; }
    const keep = new Set<number>();
    for (let i = at; i < at + SECTION_KEEP; i++) keep.add(i);
    for (let i = at + SECTION_KEEP; i < end; i++) {
      if (!ACTIONABLE.test(lines[i]!)) continue;
      keep.add(i);
      for (let up = i - 1, depth = indentOf(lines[i]!); up > at && depth > indentOf(lines[at]!); up--) if (indentOf(lines[up]!) < depth) { keep.add(up); depth = indentOf(lines[up]!); }
    }
    let skipped = 0;
    for (let i = at; i < end; i++) {
      if (keep.has(i)) { if (skipped) { out.push(`${' '.repeat(indentOf(lines[i]!))}- (… ${skipped} more lines of this section left out; find: "words" shows them)`); cut += skipped; skipped = 0; } out.push(lines[i]!); }
      else skipped++;
    }
    if (skipped) { out.push(`${' '.repeat(indentOf(lines[at + 1] ?? lines[at]!))}- (… ${skipped} more lines of this section left out; find: "words" shows them)`); cut += skipped; }
    at = end;
  }
  return { lines: out, cut };
}

/** The whole pass, for a page shown without `full`. */
export function condenseSnapshot(snapshot: string): string {
  const deduped = dedupeLinks(snapshot.split('\n'));
  const capped = capSections(shortenText(deduped.lines));
  return [...capped.lines, ...(deduped.removed ? [`- (${deduped.removed} repeated link${deduped.removed === 1 ? '' : 's'} with the same name and address left out)`] : [])].join('\n');
}

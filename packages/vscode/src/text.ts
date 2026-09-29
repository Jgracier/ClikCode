/** Terminal text made fit for an editor. */

// CSI (colours, cursor moves), OSC (titles, hyperlinks, clipboard), and the
// lone two-byte escapes; what a terminal renderer emits that a webview would
// show as garbage.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, '');
}

/** Unified-diff lines, or the two sides of an edit, as the before and after
 * documents a diff editor compares. Hunk headers and file headers are not
 * content. */
export function diffSides(diff: readonly string[] | { removed: readonly string[]; added: readonly string[] }): { before: string; after: string } {
  if (!Array.isArray(diff)) {
    const sides = diff as { removed: readonly string[]; added: readonly string[] };
    return { before: sides.removed.map(stripAnsi).join('\n'), after: sides.added.map(stripAnsi).join('\n') };
  }
  const before: string[] = [];
  const after: string[] = [];
  for (const raw of diff as readonly string[]) {
    const line = stripAnsi(raw);
    if (/^(---|\+\+\+) /.test(line) || line.startsWith('@@') || line.startsWith('diff --git') || line.startsWith('index ')) continue;
    if (line.startsWith('-')) before.push(line.slice(1));
    else if (line.startsWith('+')) after.push(line.slice(1));
    else {
      const context = line.startsWith(' ') ? line.slice(1) : line;
      before.push(context);
      after.push(context);
    }
  }
  return { before: before.join('\n'), after: after.join('\n') };
}

/** How well a path answers what was typed: the file name first, then the
 * path, then the letters in order. Undefined: no match. */
export function mentionScore(relative: string, typed: string): number | undefined {
  const query = typed.toLowerCase();
  if (!query) return 0;
  const path = relative.toLowerCase();
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (path.includes(query)) return 2;
  let at = 0;
  for (const character of query) {
    at = path.indexOf(character, at);
    if (at < 0) return undefined;
    at += 1;
  }
  return 3;
}

/** A change ClikCode's own agent describes in an approval's text: the file's
 * path on the first line, then unified-style lines (`- `, `+ `, `  `), hunks
 * separated by `⋮` (src/agent/line-diff.ts renderDiffPreview). */
export interface DetailDiff {
  path?: string;
  hunks: Array<{ before: string[]; after: string[] }>;
  /** The preview was cut short: its hunks are not the whole change. */
  truncated: boolean;
}

export function diffInDetail(detail: string | undefined): DetailDiff | undefined {
  if (!detail) return undefined;
  const lines = stripAnsi(detail).split('\n');
  const path = /^(\/|[A-Za-z]:[\\/])\S/.test(lines[0] ?? '') && !lines[0]!.includes(', ') ? lines[0]!.trim() : undefined;
  const hunks: DetailDiff['hunks'] = [];
  let current: { before: string[]; after: string[] } | undefined;
  let changed = false;
  let truncated = false;
  for (const line of lines.slice(path ? 1 : 0)) {
    if (/^why: /.test(line)) break;
    if (/^… \d+ more diff lines$|^… preview truncated$/.test(line)) { truncated = true; break; }
    if (/^\s*⋮\s*$/.test(line)) { current = undefined; continue; }
    const match = /^([-+ ])(?: (.*))?$/.exec(line);
    if (!match) { if (line.trim() === '') continue; current = undefined; continue; }
    if (!current) { current = { before: [], after: [] }; hunks.push(current); }
    const mark = match[1]!;
    const text = match[2] ?? '';
    if (mark !== '+') current.before.push(text);
    if (mark !== '-') current.after.push(text);
    if (mark !== ' ') changed = true;
  }
  if (!changed || !hunks.length) return undefined;
  return { ...(path ? { path } : {}), hunks, truncated };
}

/** The whole file after the described change, when every hunk is found
 * exactly once in `text` (in order); undefined when any is not. */
export function applyHunks(text: string, hunks: DetailDiff['hunks']): string | undefined {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let at = 0;
  for (const hunk of hunks) {
    const find = (from: number): number => {
      for (let index = from; index + hunk.before.length <= lines.length; index += 1) {
        if (hunk.before.every((line, offset) => lines[index + offset] === line)) return index;
      }
      return -1;
    };
    const index = hunk.before.length ? find(at) : (hunks.length === 1 && lines.length <= 1 && !lines[0] ? 0 : -1);
    if (index < 0 || (hunk.before.length && find(index + 1) >= 0)) return undefined;
    out.push(...lines.slice(at, index), ...hunk.after);
    at = index + hunk.before.length;
  }
  out.push(...lines.slice(at));
  return out.join(newline);
}

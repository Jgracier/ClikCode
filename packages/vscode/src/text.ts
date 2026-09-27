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

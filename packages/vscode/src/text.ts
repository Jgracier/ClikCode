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

/** A terminal note's level, from the colour it was painted in: red is a
 * failure, yellow a warning (an account switch, a limit), anything else
 * information. */
export function noticeLevel(text: string): 'info' | 'warning' | 'error' {
  // eslint-disable-next-line no-control-regex
  const colour = /\u001b\[(?:[0-9;]*;)?(3[13]|9[13])m/.exec(text)?.[1];
  return colour === '31' || colour === '91' ? 'error' : colour === '33' || colour === '93' ? 'warning' : 'info';
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

// Shared with the terminal's /undo, so both undo a turn the same way.
export { applyHunks, fileHunks, turnChanges, unwindChanges, type Hunk } from '../../../src/agent/diff-unwind';

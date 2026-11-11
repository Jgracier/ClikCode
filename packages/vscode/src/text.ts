/** Terminal text made fit for an editor. */
import { stripAnsi as stripTerminalAnsi } from '../../../src/tui/render/width';

// Escapes as the terminal strips them, then the lone control characters a
// webview would show as garbage (a terminal acts on them; an editor cannot).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
  return stripTerminalAnsi(text).replace(CONTROL, '');
}

// The bridge sends the level of the notes it forwards; this reads it from the
// colour only where there is just the text (a notice in a turn's marks).
export { noticeLevel } from '../../../src/ide/notice-level';

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

// Shared with the terminal's /redo, so both undo a turn the same way.
export { applyHunks, fileHunks, turnChanges, unwindChanges } from '../../../src/agent/diff-unwind';

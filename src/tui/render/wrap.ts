/** Breaking a line to a width, for prose and for code. */

import { expandTabs } from './text.js';
import { sliceToWidth, terminalCellWidth } from './width.js';

/** Split a code line into display-only continuation rows without modifying
 * the underlying Markdown. Unlike visibleSlice this preserves every byte;
 * continuation markers make it clear that wrapping is presentation, not a
 * newline in the model's code. */
export function wrapCodeLine(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  if (!value) return [''];
  const rows: string[] = [];
  // Expanded before measuring: a literal tab has no fixed cell width, so a row
  // that "fit" could still run past the edge once the terminal advanced it.
  let remaining = expandTabs(value);
  while (remaining && terminalCellWidth(remaining) > safeWidth) {
    const head = sliceToWidth(remaining, safeWidth);
    rows.push(head);
    remaining = remaining.slice(head.length);
  }
  rows.push(remaining);
  return rows;
}

/** Greedy word-wrap that never splits a word across lines, measuring by
 * terminal cell width (so wide/CJK characters count correctly) rather than
 * raw string length. A single word longer than `width` on its own still has
 * to be hard-broken -- there's no other way to fit it -- but that's the
 * fallback, not the common case the plain character-slice loop this
 * replaced used unconditionally. */
export function wrapWords(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    if (/^\s+$/.test(word)) {
      if (currentWidth > 0) { current += word; currentWidth += terminalCellWidth(word); }
      continue;
    }
    const wordWidth = terminalCellWidth(word);
    if (currentWidth > 0 && currentWidth + wordWidth > safeWidth) {
      lines.push(current.replace(/\s+$/, ''));
      current = '';
      currentWidth = 0;
    }
    if (wordWidth > safeWidth) {
      // Hard-breaking used to walk code points and measure the raw prefix,
      // which sliced an SGR sequence into separate rows on a narrow terminal
      // and wrote the escape out as literal `ESC [ 1 m` text.
      let remaining = word;
      while (terminalCellWidth(remaining) > safeWidth) {
        const head = sliceToWidth(remaining, safeWidth);
        lines.push(head);
        remaining = remaining.slice(head.length);
      }
      current = remaining;
      currentWidth = terminalCellWidth(remaining);
      continue;
    }
    current += word;
    currentWidth += wordWidth;
  }
  if (current || lines.length === 0) lines.push(current.replace(/\s+$/, ''));
  return lines;
}

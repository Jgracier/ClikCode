/** Breaking a line to a width, for prose and for code. */

import { expandTabs } from './text.js';
import { displayTokens, terminalCellWidth, visibleSlice } from './width.js';

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
  const { heads, rest } = breakToWidth(expandTabs(value), safeWidth);
  rows.push(...heads, rest);
  return rows;
}

/** `text` cut into rows of `width` cells while what is left is wider than
 * that: the rows, and the part that fits. Each row is sliceToWidth's -- never
 * an SGR sequence or a grapheme cluster split, a cluster wider than the row
 * still taken whole -- but measured in one pass. Re-measuring and re-slicing
 * the remainder for every row was quadratic in a long line. */
function breakToWidth(text: string, width: number): { heads: string[]; rest: string } {
  const tokens = displayTokens(text);
  const widths = tokens.map((token) => terminalCellWidth(token));
  let left = widths.reduce((sum, value) => sum + value, 0);
  const heads: string[] = [];
  let at = 0;
  while (left > width) {
    let head = '';
    let headWidth = 0;
    while (at < tokens.length && (!widths[at] || headWidth + widths[at]! <= width)) { head += tokens[at]; headWidth += widths[at]!; at += 1; }
    // Nothing visible fits: the next cluster goes alone, or nothing advances.
    if (!headWidth && at < tokens.length) { head += tokens[at]; headWidth += widths[at]!; at += 1; }
    heads.push(head);
    left -= headWidth;
  }
  return { heads, rest: tokens.slice(at).join('') };
}

/** Greedy word-wrap that never splits a word across lines, measuring by
 * terminal cell width (so wide/CJK characters count correctly) rather than
 * raw string length. A single word longer than `width` on its own still has
 * to be hard-broken -- there's no other way to fit it -- but that's the
 * fallback, not the common case the plain character-slice loop this
 * replaced used unconditionally. */
export function wrapWords(text: string, width: number): string[] {
  return wrapFrom(text, width).lines;
}

/** wrapWords, and where in `text` its last line begins (-1: nowhere it
 * could be wrapped again from). Greedy wrapping
 * never revisits a line once a later one has begun, so wrapping again from
 * that point with nothing carried over gives the same lines. */
function wrapFrom(text: string, width: number): { lines: string[]; lastStart: number } {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  let lastStart = 0;
  let at = 0;
  for (const word of text.split(/(\s+)/)) {
    const start = at;
    at += word.length;
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
    if (!current) lastStart = start;
    if (wordWidth > safeWidth) {
      // Hard-breaking used to walk code points and measure the raw prefix,
      // which sliced an SGR sequence into separate rows on a narrow terminal
      // and wrote the escape out as literal `ESC [ 1 m` text.
      // The row starts over from this word, whatever zero-width codes were
      // left of the last one.
      const { heads, rest } = breakToWidth(word, safeWidth);
      lines.push(...heads);
      lastStart = start + word.length - rest.length;
      current = rest;
      currentWidth = terminalCellWidth(rest);
      continue;
    }
    current += word;
    currentWidth += wordWidth;
  }
  if (current || lines.length === 0) lines.push(current.replace(/\s+$/, ''));
  // A hard break that used the word up has no line of its own left to resume.
  return { lines, lastStart: current ? lastStart : -1 };
}

/** The last wrap of the text still being written, to carry on from. */
let liveWrap: { text: string; width: number; lines: string[]; lastStart: number } | undefined;

/** wrapWords for the block still receiving tokens. Its lines before the last
 * one depend only on the text up to the end of the last line's first word:
 * that word's width is what broke the line before it. When this frame's text
 * still begins with all of that (it grows at the end, and only its unsettled
 * tail is ever restyled), those lines are kept and only the text from the
 * last line's start is wrapped again. A long paragraph was wrapped whole on
 * every frame. */
export function wrapWordsLive(text: string, width: number): string[] {
  const previous = liveWrap;
  const wordEnd = previous && previous.lastStart > 0 ? previous.text.slice(previous.lastStart).search(/\s/) : -1;
  if (previous && previous.width === width && wordEnd >= 0 && text.startsWith(previous.text.slice(0, previous.lastStart + wordEnd + 1))) {
    const tail = wrapFrom(text.slice(previous.lastStart), width);
    liveWrap = { text, width, lines: [...previous.lines.slice(0, -1), ...tail.lines], lastStart: tail.lastStart < 0 ? -1 : previous.lastStart + tail.lastStart };
  } else liveWrap = { text, width, ...wrapFrom(text, width) };
  return liveWrap.lines;
}

/** A notice above the composer, on at most `rows` rows: wrapped at words, a
 * word too long for a row (a path) shortened in the middle so its start and
 * its file name both show, and the last row ending in `…` when even that
 * does not fit. One row cut the file /export wrote and the list of valid
 * values an error gives. */
export function noticeLines(text: string, width: number, rows = 3): string[] {
  const safeWidth = Math.max(4, width);
  const shortened = text.replace(/\S+/g, (word) => (terminalCellWidth(word) > safeWidth ? middleSlice(word, safeWidth) : word));
  const lines = wrapWords(shortened, safeWidth);
  if (lines.length <= rows) return lines;
  const kept = lines.slice(0, rows);
  const last = kept[rows - 1]!;
  kept[rows - 1] = terminalCellWidth(last) < safeWidth ? `${last}…` : visibleSlice(last, safeWidth);
  return kept;
}

/** `/home/me/very/long/…/file.md`: the start and the end, `…` between, in
 * `width` cells. */
export function middleSlice(value: string, width: number): string {
  if (terminalCellWidth(value) <= width) return value;
  const characters = [...value];
  const tailRoom = Math.ceil((width - 1) / 2);
  let tail = '';
  for (let index = characters.length - 1; index >= 0 && terminalCellWidth(characters[index]! + tail) <= tailRoom; index -= 1) tail = characters[index]! + tail;
  // visibleSlice ends what it cuts with the `…`.
  return `${visibleSlice(value, width - terminalCellWidth(tail))}${tail}`;
}

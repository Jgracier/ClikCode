/** How wide a string is on screen, and where its characters begin and end.
 * A code point is not a cell: emoji, CJK and combining marks all break the
 * assumption that one character is one column. */

import { HYPERLINK_CLOSE } from './hyperlinks.js';

/** Moved down here from text.ts: width.ts needs all three to measure a
 * string, and text.ts needs terminalCellWidth to lay one out, so keeping
 * them up there made the two modules import each other. They are pure
 * data with no dependencies, so the lower module is their right home. */
export const OSC8_SEQUENCE = /^\u001b\]8;[^\u0007\u001b\n]*\u001b\\$/;
export const ZERO_WIDTH_SEQUENCES = /\u001b\[[0-9;]*m|\u001b\]8;[^\u0007\u001b\n]*\u001b\\/g;
export const TAB_WIDTH = 4;

export function visibleSlice(value: string, width: number): string {
  if (terminalCellWidth(value) <= width) return value;
  const available = Math.max(0, width - 1);
  let rendered = '';
  let renderedWidth = 0;
  let sawAnsi = false;
  // Control sequences are atomic zero-width tokens. Slicing their individual
  // bytes can leave a partial escape in the terminal, causing color bleed,
  // question marks, and adjacent rows that appear to run together.
  const tokens = displayTokens(value);
  let linkOpen = false;
  for (const token of tokens) {
    if (token[0] === '\u001b') {
      rendered += token;
      if (OSC8_SEQUENCE.test(token)) linkOpen = token !== HYPERLINK_CLOSE;
      else sawAnsi = true;
      continue;
    }
    const tokenWidth = terminalCellWidth(token);
    if (renderedWidth + tokenWidth > available) break;
    rendered += token;
    renderedWidth += tokenWidth;
  }
  return `${rendered}${linkOpen ? HYPERLINK_CLOSE : ''}${sawAnsi ? '\u001b[0m' : ''}…`;
}

/** A user-perceived character is a grapheme cluster, not a code point: a
 * combining accent, a skin-tone modifier, a variation selector, and a ZWJ
 * family emoji are all several code points the terminal draws -- and the user
 * edits -- as one unit. Width, cursor motion, and deletion all agree on this
 * boundary, so backspace can never strand half an emoji in the composer. */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** No realistic cluster approaches this many code units, so bounding the
 * segmented window keeps cursor motion O(1) rather than re-segmenting the
 * whole buffer on every keystroke -- which the input decoder does once per
 * pasted character. */
const CLUSTER_WINDOW = 32;

function isWideCodePoint(code: number): boolean {
  if (code < 0x1100) return false;
  return code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    // A regional-indicator pair renders as one two-cell flag.
    || (code >= 0x1f1e6 && code <= 0x1f1ff)
    || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd);
}

/** Split into atomic display tokens: each SGR sequence stays whole (slicing
 * one leaks a partial escape into the terminal) and each grapheme cluster
 * stays whole (slicing one strands a dangling joiner or combining mark, which
 * renders as a broken glyph). Everything that truncates or hard-wraps shares
 * this so no caller has to rediscover either rule. */
function displayTokens(value: string): string[] {
  const tokens: string[] = [];
  const pushText = (text: string): void => {
    for (const { segment } of graphemes.segment(text)) tokens.push(segment);
  };
  let consumed = 0;
  for (const match of value.matchAll(ZERO_WIDTH_SEQUENCES)) {
    const start = match.index;
    if (start > consumed) pushText(value.slice(consumed, start));
    tokens.push(match[0]);
    consumed = start + match[0].length;
  }
  if (consumed < value.length) pushText(value.slice(consumed));
  return tokens;
}

/** Longest prefix of `value` fitting `width` cells, never splitting an SGR
 * sequence or a grapheme cluster. Zero-width tokens are always carried along,
 * so a style never survives as a half-written escape in the terminal.
 *
 * It always consumes at least one visible cluster: a character wider than the
 * row (a CJK glyph in a one-column gutter) must still advance, or every caller
 * that loops on the remainder would spin forever. */
export function sliceToWidth(value: string, width: number): string {
  let taken = '';
  let takenWidth = 0;
  for (const token of displayTokens(value)) {
    const tokenWidth = terminalCellWidth(token);
    if (tokenWidth && takenWidth + tokenWidth > width) break;
    taken += token;
    takenWidth += tokenWidth;
  }
  if (takenWidth > 0) return taken;
  let forced = '';
  for (const token of displayTokens(value)) {
    forced += token;
    if (terminalCellWidth(token)) return forced;
  }
  return value;
}

export function terminalCellWidth(value: string): number {
  const plain = value.includes('\u001b') ? value.replace(ZERO_WIDTH_SEQUENCES, '') : value;
  let width = 0;
  for (const { segment } of graphemes.segment(plain)) {
    if (segment === '\t') { width += TAB_WIDTH - (width % TAB_WIDTH); continue; }
    // Other control characters occupy no cell (and are stripped before paint).
    if (segment.length === 1 && /[\u0000-\u001f\u007f-\u009f]/.test(segment)) continue;
    // The base character decides the cell count; whatever the cluster attaches
    // to it (marks, variation selectors, joiners) draws inside those cells.
    const base = String.fromCodePoint(segment.codePointAt(0) ?? 0);
    if (/\p{Mark}/u.test(base)) continue;
    // Presentation is part of the width. U+FE0F asks for the emoji glyph, which
    // terminals draw two cells wide even for a symbol that is one cell as text
    // (U+2611 BALLOT BOX, U+2764 HEART); U+FE0E asks for the narrow text glyph.
    // Symbols that default to emoji presentation (U+26A1, U+2705) are wide on
    // their own.
    const wide = segment.includes('\ufe0e') ? isWideCodePoint(base.codePointAt(0) ?? 0) && (base.codePointAt(0) ?? 0) >= 0x1f000
      : isWideCodePoint(base.codePointAt(0) ?? 0)
        || /\p{Emoji_Presentation}/u.test(base)
        || (segment.includes('\ufe0f') && /\p{Emoji}/u.test(base) && !/^[0-9#*]$/.test(base))
        || (segment.includes('\u20e3'));
    width += wide ? 2 : 1;
  }
  return width;
}

export function previousCharacterIndex(value: string, index: number): number {
  if (index <= 0) return 0;
  const start = Math.max(0, index - CLUSTER_WINDOW);
  let boundary = 0;
  for (const { index: offset } of graphemes.segment(value.slice(start, index))) boundary = offset;
  return start + boundary;
}

export function nextCharacterIndex(value: string, index: number): number {
  if (index >= value.length) return value.length;
  const [first] = graphemes.segment(value.slice(index, index + CLUSTER_WINDOW));
  return index + (first ? first.segment.length : 1);
}

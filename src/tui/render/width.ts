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

/** The END of plain text that fits `width` cells, with a leading ellipsis
 * when anything was cut: for text whose newest part is the one worth
 * reading, a thought still being written. SGR is not expected here. */
export function visibleTail(value: string, width: number): string {
  if (terminalCellWidth(value) <= width) return value;
  const tokens = displayTokens(value);
  let kept = '';
  let keptWidth = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const tokenWidth = terminalCellWidth(tokens[index]!);
    if (keptWidth + tokenWidth > Math.max(0, width - 1)) break;
    kept = tokens[index]! + kept;
    keptWidth += tokenWidth;
  }
  return `…${kept}`;
}

/** `…/clikcode`: a path cut from the left at a separator, so the folder it
 * ends in -- the one that says where this is -- stays whole. */
export function visiblePathTail(path: string, width: number): string {
  if (terminalCellWidth(path) <= width) return path;
  const parts = path.split(/(?=[\\/])/);
  let kept = '';
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (terminalCellWidth(`…${parts[index]}${kept}`) > width) break;
    kept = `${parts[index]}${kept}`;
  }
  return kept ? `…${kept}` : visibleSlice(`…${parts[parts.length - 1]}`, width);
}

/** A user-perceived character is a grapheme cluster, not a code point: a
 * combining accent, a skin-tone modifier, a variation selector, and a ZWJ
 * family emoji are all several code points the terminal draws -- and the user
 * edits -- as one unit. Width, cursor motion, and deletion all agree on this
 * boundary, so backspace can never strand half an emoji in the composer.
 * The segmenter is made on first use: building one loads ICU's break rules,
 * about 6 ms a worker, the editor bridge or `--version` paid at load. */
let graphemeSegmenter: Intl.Segmenter | undefined;
const graphemes = (): Intl.Segmenter => (graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' }));

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
export function displayTokens(value: string): string[] {
  const tokens: string[] = [];
  const pushText = (text: string): void => {
    for (const { segment } of graphemes().segment(text)) tokens.push(segment);
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

const CONTROLS = /^[\u0000-\u001f\u007f-\u009f]+$/;
const MARK = /\p{Mark}/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EMOJI = /\p{Emoji}/u;
const KEYCAP_BASE = /^[0-9#*]$/;
const GRAPHEME_EXTEND = /\p{Grapheme_Extend}/u;

/** BMP characters that are one cell and always a cluster of their own (see
 * oneCell), decided the first time each is met: 0 not yet, 1 yes, 2 no. */
const ONE_CELL = new Uint8Array(0x10000);

/** Whether a BMP code unit at or above U+00A0 is one cell however it is
 * surrounded by others like it: not a mark or other extender, not wide, not
 * emoji by default, not a surrogate half, and none of what the grapheme
 * rules join to a neighbour -- Hangul jamo, the Prepend characters, the two
 * SpacingMark letters (U+0E33, U+0EB3), the zero-width joiner. Checked
 * against Intl.Segmenter over every BMP character when this was written. */
function oneCell(code: number): boolean {
  let known = ONE_CELL[code]!;
  if (!known) {
    const character = String.fromCharCode(code);
    const joins = (code >= 0xd800 && code <= 0xdfff)
      || (code >= 0x1100 && code <= 0x11ff) || (code >= 0xa960 && code <= 0xa97f) || (code >= 0xd7b0 && code <= 0xd7ff)
      || (code >= 0x600 && code <= 0x605) || code === 0x6dd || code === 0x70f || code === 0x890 || code === 0x891
      || code === 0x8e2 || code === 0xd4e || code === 0xe33 || code === 0xeb3 || code === 0x200d;
    known = joins || isWideCodePoint(code) || MARK.test(character) || GRAPHEME_EXTEND.test(character)
      || EMOJI_PRESENTATION.test(character) ? 2 : 1;
    ONE_CELL[code] = known;
  }
  return known === 1;
}

/** Width of text made only of characters that are always one cell and never
 * join a cluster, or -1 when any character is not. Nearly every string the
 * renderer measures is text like that -- ASCII, accents, bullets, arrows, box
 * rules, spinner braille -- with this UI's own SGR and OSC 8 sequences in it,
 * where stripping those with a regex, the grapheme segmenter and its
 * Unicode-property tests are pure cost. The two zero-width sequences are stepped over in place; anything else
 * that could combine (marks, joiners, variation selectors), be wide (CJK,
 * emoji) or be another escape takes the full path. */
function simpleWidth(value: string): number {
  let width = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code < 0x7f) width += 1;
    else if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      let end = index + 2;
      if (next === 0x5b) { // CSI: only SGR (`ESC [ digits;… m`) is zero-width
        while (end < value.length && ((value.charCodeAt(end) >= 0x30 && value.charCodeAt(end) <= 0x39) || value.charCodeAt(end) === 0x3b)) end += 1;
        if (value.charCodeAt(end) !== 0x6d) return -1;
      } else if (next === 0x5d && value.startsWith('8;', end)) { // OSC 8, ended by ST
        while (end < value.length && !'\u0007\u001b\n'.includes(value[end]!)) end += 1;
        if (value.charCodeAt(end) !== 0x1b || value.charCodeAt(end + 1) !== 0x5c) return -1;
        end += 1;
      } else return -1;
      index = end;
    } else if (code === 0x09) width += TAB_WIDTH - (width % TAB_WIDTH);
    else if (code < 0xa0) continue; // C0/C1 controls draw nothing
    else if (oneCell(code)) width += 1;
    else return -1;
  }
  return width;
}

export function terminalCellWidth(value: string): number {
  const simple = simpleWidth(value);
  if (simple >= 0) return simple;
  const plain = value.includes('\u001b') ? value.replace(ZERO_WIDTH_SEQUENCES, '') : value;
  let width = 0;
  for (const { segment } of graphemes().segment(plain)) {
    if (segment === '\t') { width += TAB_WIDTH - (width % TAB_WIDTH); continue; }
    // Other control characters occupy no cell (and are stripped before paint),
    // CRLF included, which the segmenter makes one cluster.
    if (CONTROLS.test(segment)) continue;
    const code = segment.codePointAt(0) ?? 0;
    // Printable ASCII alone is one cell; only a cluster built on it (a keycap)
    // needs the tests below.
    if (segment.length === 1 && code < 0x7f) { width += 1; continue; }
    // The base character decides the cell count; whatever the cluster attaches
    // to it (marks, variation selectors, joiners) draws inside those cells.
    const base = String.fromCodePoint(code);
    if (MARK.test(base)) continue;
    // Presentation is part of the width. U+FE0F asks for the emoji glyph, which
    // terminals draw two cells wide even for a symbol that is one cell as text
    // (U+2611 BALLOT BOX, U+2764 HEART); U+FE0E asks for the narrow text glyph.
    // Symbols that default to emoji presentation (U+26A1, U+2705) are wide on
    // their own.
    const wide = segment.includes('\ufe0e') ? isWideCodePoint(code) && code >= 0x1f000
      : isWideCodePoint(code)
        || EMOJI_PRESENTATION.test(base)
        || (segment.includes('\ufe0f') && EMOJI.test(base) && !KEYCAP_BASE.test(base))
        || (segment.includes('\u20e3'));
    width += wide ? 2 : 1;
  }
  return width;
}

export function previousCharacterIndex(value: string, index: number): number {
  if (index <= 0) return 0;
  const start = Math.max(0, index - CLUSTER_WINDOW);
  let boundary = 0;
  for (const { index: offset } of graphemes().segment(value.slice(start, index))) boundary = offset;
  return start + boundary;
}

export function nextCharacterIndex(value: string, index: number): number {
  if (index >= value.length) return value.length;
  const [first] = graphemes().segment(value.slice(index, index + CLUSTER_WINDOW));
  return index + (first ? first.segment.length : 1);
}

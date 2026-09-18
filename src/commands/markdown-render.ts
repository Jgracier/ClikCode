/** Pure text/markdown rendering for the terminal UI -- header, bullet, and
 * inline (bold/italic/code/link) formatting, plus ANSI-cell-width-aware
 * word-wrapping and composer-viewport scrolling. Nothing here depends on
 * HarnessSession/HarnessState -- every function takes plain strings and
 * returns plain strings, so this is safe to import from anywhere without
 * pulling in the whole broker. */

import chalk from 'chalk';
import type { FormattedParagraph, MessageBlock } from './types.js';


/** Vendor responses come back as real markdown, but the transcript view is a
 * fixed-width character grid with no rich-text renderer behind it — showing
 * that syntax verbatim (literal ** around bold text, backticks around code,
 * a raw [text](url) pair) reads as visibly broken rather than styled. Strips
 * the syntax down to plain, readable text instead of attempting real
 * rendering: bold/italic markers are dropped (chalk styling would have to
 * survive the character-offset word-wrap below, which slices through ANSI
 * codes with no awareness of them), inline code keeps its content without
 * the backticks, and links keep their label with the URL alongside it. */
/** Applies `style` to each word of `text` individually, leaving whitespace
 * untouched -- not one open/close pair around the whole phrase. wrapWords
 * measures visible width correctly through embedded ANSI codes already, but
 * it still breaks lines on whitespace, so a single open-code-at-the-start,
 * close-code-at-the-end span would leave its close code stranded on a
 * different wrapped line than its open code if the phrase wraps, `-- not
 * corrupting anything (chalk's own codes are self-contained), but silently
 * losing the styling on whichever words landed after the break. Per-word
 * styling means every word carries its own complete open+close pair, so a
 * mid-phrase wrap just ends one styled run and starts another identical
 * one -- no dependency on where the line happens to break. */
export function styleWords(text: string, style: (word: string) => string): string {
  return text.split(/(\s+)/).map((part) => (part && !/^\s+$/.test(part) ? style(part) : part)).join('');
}

/** Inline spans (bold/italic/code/links) get real ANSI styling instead of
 * being discarded -- unlike the header/bullet/list handling in
 * formatParagraph, which strips its own markers because the paragraph-level
 * prefix system already conveys that structure. Code spans are converted
 * first, specifically so literal asterisks inside inline code (a glob
 * pattern, a multiplication in a comment) can't get misread as a bold/italic
 * marker by the regexes that run after -- the reverse order would let
 * that happen, and the original plain-text stripMarkdown() this replaced
 * had exactly that latent ordering issue. */
// One combined regex, one single `.replace()` pass -- NOT the sequential
// per-construct `.replace()` chain this used to be. That chain had a real
// bug: each pass ran against the *output* of the previous one, which by
// then already contained chalk escape codes like `\x1b[1m` -- and an escape
// code's own `[` is indistinguishable, to a naive `\[...\]` link regex,
// from a real markdown link's opening bracket. A bold span earlier in the
// paragraph could supply that stray `[`, and the link regex would then
// greedily consume everything from there up to the *next* real `]` --
// which might be a real link many words later -- wrapping that whole
// stretch in underline. Matching everything in one pass against the
// original, escape-code-free text closes that off entirely: every
// construct is found at its real source position exactly once, and nothing
// ever gets re-scanned after styling is applied.
export const INLINE_MARKDOWN_PATTERN = /`([^`]+)`|(\*\*\*|___)(.+?)\2|(\*\*|__)(.+?)\4|(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)|\[([^\]]+)\]\(([^)]+)\)/g;

export function renderInlineMarkdown(text: string): string {
  return text.replace(
    INLINE_MARKDOWN_PATTERN,
    (_match, code: string | undefined, _boldItalicMarker, boldItalic: string | undefined, _boldMarker, bold: string | undefined, italic: string | undefined, linkLabel: string | undefined, linkUrl: string | undefined) => {
      if (code !== undefined) return styleWords(code, (word) => chalk.cyan(word));
      if (boldItalic !== undefined) return styleWords(boldItalic, (word) => chalk.bold(chalk.italic(word)));
      if (bold !== undefined) return styleWords(bold, (word) => chalk.bold(word));
      if (italic !== undefined) return styleWords(italic, (word) => chalk.italic(word));
      if (linkLabel !== undefined) return `${styleWords(linkLabel, (word) => chalk.underline(word))} ${chalk.dim(`(${linkUrl})`)}`;
      return _match;
    },
  );
}


/** Fenced code blocks are pulled out as their own non-reflowed unit before
 * the normal per-paragraph pipeline ever sees them -- word-wrapping code
 * would change what it means (a wrapped shell command or JSON blob reads
 * differently than the original), so those lines get hard-truncated instead
 * of wrapped when rendered, same principle as visibleSlice elsewhere in
 * this file. */
export function splitIntoBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const parts = text.split(/```[a-z]*\n?/i);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      blocks.push({ kind: 'code', lines: part.replace(/```$/, '').split(/\r?\n/).filter((_line, lineIndex, all) => !(lineIndex === all.length - 1 && all[lineIndex] === '')) });
    } else {
      for (const paragraph of part.split(/\r?\n/)) blocks.push({ kind: 'text', paragraph });
    }
  });
  return blocks;
}

/** Every harness's assistant text is plain markdown-convention prose
 * regardless of vendor, so this -- unlike HarnessActivityEvent's per-vendor
 * JSON parsing -- applies identically no matter which harness produced the
 * paragraph: a header renders bold, a list item gets a dim glyph and a
 * hanging indent for any wrapped continuation lines, and anything else
 * passes through untouched. Deliberately paragraph-level, not span-level --
 * inline styling (bold *within* a sentence) would need wrapWords to track
 * open ANSI codes across a wrap boundary, which stripMarkdown already
 * discards to plain text; a header or list marker is always at the start of
 * its own paragraph, so no such boundary problem exists here. */

export function formatParagraph(paragraph: string): FormattedParagraph {
  if (/^([-*_])\1{2,}\s*$/.test(paragraph.trim())) return { prefix: '', hangIndent: '', text: '', bold: false, rule: true };
  const header = /^#{1,6}\s+(.*)$/.exec(paragraph);
  if (header) return { prefix: '', hangIndent: '', text: header[1], bold: true, rule: false };
  const quote = /^>\s?(.*)$/.exec(paragraph);
  // Only the marker is dim, not chalk.dim() around the whole line -- bold
  // and dim share the same SGR "normal intensity" reset code (22), so
  // concatenating a dim-wrapped string around a separately-bold-wrapped
  // inline span (from renderInlineMarkdown, applied after this returns)
  // would let the bold span's own reset code end the dim early for the
  // rest of the line. Chalk only fixes that automatically for styles
  // nested as actual JS calls (chalk.dim(chalk.bold(x))), not for
  // pre-rendered strings spliced together afterward, which is what happens
  // here -- so this sidesteps the collision instead of triggering it.
  if (quote) return { prefix: `${chalk.dim('│')} `, hangIndent: '  ', text: quote[1], bold: false, rule: false };
  const bullet = /^([-*+])\s+(.*)$/.exec(paragraph);
  if (bullet) return { prefix: `${chalk.dim('•')} `, hangIndent: ' '.repeat(2), text: bullet[2], bold: false, rule: false };
  const numbered = /^(\d+[.)])\s+(.*)$/.exec(paragraph);
  // hangIndent is a plain space string matching the *visible* width of
  // `prefix` (marker plus its trailing space) exactly -- not a rounded
  // approximation -- so a wrapped continuation line lines up under the
  // first line's text instead of drifting a column off, which an earlier
  // "round up to a 2-space unit" version of this got wrong for any
  // odd-length marker (e.g. a 2-character "2." plus its space is 3 wide,
  // not the 4 that formula produced).
  if (numbered) return { prefix: `${chalk.dim(numbered[1])} `, hangIndent: ' '.repeat(numbered[1].length + 1), text: numbered[2], bold: false, rule: false };
  return { prefix: '', hangIndent: '', text: paragraph, bold: false, rule: false };
}

export function visibleSlice(value: string, width: number): string {
  if (terminalCellWidth(value) <= width) return value;
  const available = Math.max(0, width - 1);
  let rendered = '';
  for (const character of value) {
    if (terminalCellWidth(rendered + character) > available) break;
    rendered += character;
  }
  return `${rendered}…`;
}

export function terminalCellWidth(value: string): number {
  const plain = value.replace(/\u001b\[[0-9;]*m/g, '');
  let width = 0;
  for (const character of plain) {
    const code = character.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(character) || code === 0xfe0f) continue;
    width += code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)) ? 2 : 1;
  }
  return width;
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
      let remaining = word;
      while (terminalCellWidth(remaining) > safeWidth) {
        let cut = 0;
        for (const character of remaining) {
          if (terminalCellWidth(remaining.slice(0, cut + character.length)) > safeWidth) break;
          cut += character.length;
        }
        cut = Math.max(cut, 1);
        lines.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
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

export function previousCharacterIndex(value: string, index: number): number {
  if (index <= 0) return 0;
  const code = value.charCodeAt(index - 1);
  return code >= 0xdc00 && code <= 0xdfff && index > 1 ? index - 2 : index - 1;
}

export function nextCharacterIndex(value: string, index: number): number {
  if (index >= value.length) return value.length;
  const code = value.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff && index + 1 < value.length ? index + 2 : index + 1;
}

export function composerViewport(value: string, cursor: number, available: number): { text: string; cursorWidth: number } {
  if (terminalCellWidth(value) <= available) return { text: value, cursorWidth: terminalCellWidth(value.slice(0, cursor)) };
  let start = 0;
  while (start < cursor && terminalCellWidth(value.slice(start, cursor)) > available - 2) start = nextCharacterIndex(value, start);
  const prefix = start > 0 ? '…' : '';
  let end = value.length;
  while (end > cursor && terminalCellWidth(prefix + value.slice(start, end)) > available) end = previousCharacterIndex(value, end);
  const suffix = end < value.length ? '…' : '';
  while (end > cursor && terminalCellWidth(prefix + value.slice(start, end) + suffix) > available) end = previousCharacterIndex(value, end);
  return { text: `${prefix}${value.slice(start, end)}${suffix}`, cursorWidth: terminalCellWidth(prefix + value.slice(start, cursor)) };
}

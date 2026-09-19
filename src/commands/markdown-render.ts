/** Pure text/markdown rendering for the terminal UI -- header, bullet, and
 * inline (bold/italic/code/link) formatting, plus ANSI-cell-width-aware
 * word-wrapping and composer-viewport scrolling. Nothing here depends on
 * HarnessSession/HarnessState -- every function takes plain strings and
 * returns plain strings, so this is safe to import from anywhere without
 * pulling in the whole broker. */

import chalk from 'chalk';
import { Lexer, marked, type Token, type Tokens } from 'marked';
import type { MessageBlock } from './types.js';


/** Least-recently-USED, not least-recently-added: a Map iterates in insertion
 * order, so re-inserting on every hit keeps the entries a repaint actually
 * touches (the forty messages on screen) and evicts the ones it does not. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();
  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  has(key: K): boolean { return this.entries.has(key); }
  get size(): number { return this.entries.size; }
}

/** A repaint re-lays-out every message on screen. Keying on the exact source
 * text turns the settled messages into cache hits. Text that is still being
 * streamed must NOT come through here -- every delta is a brand new key holding
 * the whole answer so far, which filled the cache with dead prefixes and
 * evicted the settled messages it exists for; see createStreamingBlockParser
 * and renderInlineMarkdownLive. Results are immutable by contract. */
function memoizeByText<T>(compute: (text: string) => T, limit = 256): (text: string) => T {
  const cache = new LruCache<string, { value: T }>(limit);
  return (text) => {
    const hit = cache.get(text);
    if (hit) return hit.value;
    const value = compute(text);
    cache.set(text, { value });
    return value;
  };
}

/** Every escape sequence a terminal acts on. OSC and DCS/SOS/PM/APC bodies end
 * at their terminator or, failing that, at the end of the line: a model that
 * emits an unterminated `ESC ]` must not swallow the rest of its own answer. */
const ESCAPE_SEQUENCE = new RegExp([
  '\\u001b\\][^\\u0007\\u001b\\n]*(?:\\u0007|\\u001b\\\\)?',
  '\\u001b[PX^_][^\\u001b\\n]*(?:\\u001b\\\\)?',
  '(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*[@-~]?',
  '\\u001b[ -/]*[0-~]?',
].join('|'), 'g');
const SGR_SEQUENCE = /^\u001b\[[0-9;]*m$/;
const NEEDS_SANITIZING = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\t]/;
const UNSAFE_IN_STYLED_TEXT = /[\u0000-\u0009\u000b-\u001a\u001c-\u001f\u007f-\u009f]|\u001b(?!\[[0-9;]*m)/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const TAB_WIDTH = 4;

/** Advance each tab to the next tab stop measured from the start of its own
 * line, which is what keeps tab-aligned code aligned. */
export function expandTabs(value: string, tabWidth = TAB_WIDTH): string {
  if (!value.includes('\t')) return value;
  return value.split('\n').map((line) => {
    if (!line.includes('\t')) return line;
    let column = 0;
    let expanded = '';
    for (const [index, part] of line.split('\t').entries()) {
      if (index > 0) {
        const fill = tabWidth - (column % tabWidth);
        expanded += ' '.repeat(fill);
        column += fill;
      }
      expanded += part;
      column += terminalCellWidth(part);
    }
    return expanded;
  }).join('\n');
}

/** The single choke point for text that did not originate in this program: a
 * paste, model output, tool output. A raw `\r` rewinds the row and overwrites
 * it, a tab moves the cursor by an amount the layout never measured, and an
 * escape sequence can retitle the window, write the clipboard (OSC 52), or
 * move the cursor out of the live region and corrupt every later frame.
 *
 * `keepSgr` is for rows this UI styled itself; untrusted text never keeps any
 * escape. Newlines survive unless `singleLine` folds them into spaces. */
export function sanitizeTerminalText(
  value: string, options: { keepSgr?: boolean; singleLine?: boolean; tabWidth?: number } = {},
): string {
  // Styled rows are checked on every frame, so the common clean case must not
  // pay for a rewrite just because it carries this UI's own color codes.
  const clean = options.keepSgr ? !UNSAFE_IN_STYLED_TEXT.test(value) : !NEEDS_SANITIZING.test(value);
  if (clean && !(options.singleLine && value.includes('\n'))) return value;
  let text = value.replace(/\r\n?/g, '\n');
  text = text.replace(ESCAPE_SEQUENCE, (sequence) => (options.keepSgr && SGR_SEQUENCE.test(sequence) ? sequence : ''));
  text = text.replace(CONTROL_CHARACTERS, (character) => (character === '\u001b' && options.keepSgr ? character : ''));
  if (options.keepSgr) text = text.replace(/\u001b(?!\[[0-9;]*m)/g, '');
  text = expandTabs(text, options.tabWidth ?? TAB_WIDTH);
  return options.singleLine ? text.replace(/\n/g, ' ') : text;
}

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

/** Render CommonMark/GFM inline tokens directly to self-contained ANSI spans.
 * Tokenizing before styling prevents escape sequences from being reparsed as
 * markdown and keeps styling valid when the terminal wraps a line. */
const renderInlineMarkdownUncached = (text: string): string => {
  type Style = (value: string) => string;
  const render = (tokens: Token[], styles: Style[] = []): string => tokens.map((token) => {
    const apply = (value: string, extra: Style[] = styles): string => styleWords(value, (word) => extra.reduce((result, style) => style(result), word));
    if (token.type === 'strong') return render(token.tokens ?? [], [...styles, chalk.bold]);
    if (token.type === 'em') return render(token.tokens ?? [], [...styles, chalk.italic]);
    if (token.type === 'del') return render(token.tokens ?? [], [...styles, chalk.strikethrough]);
    if (token.type === 'codespan') return apply(token.text, [...styles, chalk.cyan]);
    if (token.type === 'link') return `${render(token.tokens ?? [], [...styles, chalk.underline])} ${chalk.dim(`(${token.href})`)}`;
    if (token.type === 'image') return `${chalk.magenta(`[image: ${token.text || 'attachment'}]`)} ${chalk.dim(`(${token.href})`)}`;
    if (token.type === 'br') return ' ';
    if ('tokens' in token && Array.isArray(token.tokens)) return render(token.tokens, styles);
    if ('text' in token && typeof token.text === 'string') return apply(token.text);
    return typeof token.raw === 'string' ? apply(token.raw) : '';
  }).join('');
  return render(Lexer.lexInline(text, { gfm: true, breaks: false }));
};
export const renderInlineMarkdown = memoizeByText(renderInlineMarkdownUncached);
/** For the block that is still receiving tokens: same output, no cache entry. */
export const renderInlineMarkdownLive = renderInlineMarkdownUncached;


/** Convert the original CommonMark/GFM block tree into the small semantic
 * document model used by the terminal. Code remains distinct from prose so
 * display-only continuation rows can preserve every byte without pretending
 * those visual wraps are source newlines. */
interface ParsedBlocks {
  blocks: MessageBlock[];
  /** Source offset and block count at the start of the last top-level token,
   * when a blank line separates it from what came before. Text only ever grows
   * at the end, and a blank line is what stops a later line from merging into
   * the previous construct (a setext underline, a lazy continuation, a table
   * delimiter row), so everything before this point parses the same forever. */
  stable?: { offset: number; blocks: number };
  /** Link reference definitions resolve across the whole document, so a text
   * that has any cannot be parsed in independent pieces. */
  hasDefinitions: boolean;
}

const parseBlocks = (text: string): ParsedBlocks => {
  const blocks: MessageBlock[] = [];
  let hasDefinitions = false;
  let stable: ParsedBlocks['stable'];
  let previousType = '';
  const visit = (tokens: Token[], sourceEnd: number, quoteDepth = 0, listDepth = 0): void => {
    for (const token of tokens) {
      if (token.type === 'def') hasDefinitions = true;
      if (token.type === 'space' || token.type === 'def') continue;
      if (token.type === 'code') {
        blocks.push({ kind: 'code', lines: token.text.split(/\r?\n/), ...(token.lang ? { language: token.lang } : {}), quoteDepth, indent: listDepth, sourceEnd });
      } else if (token.type === 'heading') {
        blocks.push({ kind: 'heading', text: token.text, level: token.depth, quoteDepth, sourceEnd });
      } else if (token.type === 'hr') {
        blocks.push({ kind: 'rule', quoteDepth, sourceEnd });
      } else if (token.type === 'paragraph' || token.type === 'text' || token.type === 'html') {
        blocks.push({ kind: 'paragraph', text: token.text, quoteDepth, indent: listDepth, sourceEnd });
      } else if (token.type === 'blockquote') {
        visit(token.tokens ?? [], sourceEnd, quoteDepth + 1, listDepth);
      } else if (token.type === 'table') {
        const table = token as Tokens.Table;
        blocks.push({
          kind: 'table', header: table.header.map((cell) => cell.text), rows: table.rows.map((row) => row.map((cell) => cell.text)),
          align: table.align, quoteDepth, sourceEnd,
        });
      } else if (token.type === 'list') {
        const list = token as Tokens.List;
        list.items.forEach((item: Tokens.ListItem, index: number) => {
          const children = item.tokens ?? [];
          const primaryIndex = children.findIndex((child: Token) => child.type === 'text' || child.type === 'paragraph');
          const primary = primaryIndex >= 0 ? children[primaryIndex] : undefined;
          const first = primary && 'text' in primary && typeof primary.text === 'string' ? primary.text : '';
          blocks.push({
            kind: 'list-item', text: first, depth: listDepth, ordered: list.ordered,
            ...(list.ordered ? { number: Number(list.start || 1) + index } : {}),
            task: item.task, ...(item.task ? { checked: item.checked } : {}), quoteDepth, sourceEnd,
          });
          children.forEach((child: Token, childIndex: number) => {
            if (childIndex === primaryIndex) return;
            visit([child], sourceEnd, quoteDepth, listDepth + 1);
          });
        });
      }
    }
  };
  let sourceEnd = 0;
  for (const token of marked.lexer(text, { gfm: true, breaks: false })) {
    const sourceStart = sourceEnd;
    sourceEnd += token.raw.length;
    if (token.type === 'space') {
      // Blank lines are safe insertion points even though they do not render
      // a block. Extend the preceding block through that whitespace so a tool
      // emitted between paragraphs stays between paragraphs instead of being
      // delayed until after the following block.
      const previous = blocks[blocks.length - 1];
      if (previous) previous.sourceEnd = sourceEnd;
      previousType = 'space';
      continue;
    }
    const blockStart = blocks.length;
    if (previousType === 'space' && blockStart > 0) stable = { offset: sourceStart, blocks: blockStart };
    previousType = token.type;
    visit([token], sourceEnd);
    // Compound Markdown tokens (notably lists and blockquotes) produce
    // several display blocks but have only one safe outer boundary. Prevent
    // an event whose offset is inside that construct from being emitted after
    // its first child and visually splitting the Markdown structure.
    for (let index = blockStart; index < blocks.length - 1; index++) blocks[index]!.sourceEnd = sourceStart;
    // A compound token such as a list or blockquote may create many visual
    // rows, but only its final row closes the top-level Markdown construct.
    // The streaming renderer uses this marker to avoid freezing an early
    // bullet before a later/nested bullet has finished parsing.
    const finalBlock = blocks[blocks.length - 1];
    if (finalBlock && blocks.length > blockStart) finalBlock.blockBoundary = true;
  }
  return { blocks, ...(stable ? { stable } : {}), hasDefinitions };
};
export const splitIntoBlocks = memoizeByText((text: string): MessageBlock[] => parseBlocks(text).blocks);

/** Block parser for one growing message. Re-lexing the whole answer on every
 * delta is quadratic over a long response; this keeps the blocks before the
 * last blank-line boundary and lexes only the text after it. The result is
 * identical to splitIntoBlocks(text) -- the persisted copy of the same answer
 * goes through that, and the two must lay out alike -- and nothing is cached
 * under the streaming text itself. */
export function createStreamingBlockParser(): (text: string) => MessageBlock[] {
  let stableText = '';
  let stableBlocks: MessageBlock[] = [];
  let incremental = true;
  return (text) => {
    if (!text.startsWith(stableText)) {
      // A replacement stream rewrote earlier text: start over.
      stableText = '';
      stableBlocks = [];
      incremental = true;
    }
    if (!incremental) return parseBlocks(text).blocks;
    const offset = stableText.length;
    const tail = parseBlocks(text.slice(offset));
    if (tail.hasDefinitions) {
      incremental = false;
      stableText = '';
      stableBlocks = [];
      return parseBlocks(text).blocks;
    }
    const shifted = offset === 0 ? tail.blocks : tail.blocks.map((block) => ({ ...block, sourceEnd: block.sourceEnd + offset }));
    const blocks = [...stableBlocks, ...shifted];
    if (tail.stable) {
      stableBlocks = blocks.slice(0, stableBlocks.length + tail.stable.blocks);
      stableText = text.slice(0, offset + tail.stable.offset);
    }
    return blocks;
  };
}

/** Width-bounded GFM table rendering. Equal columns are predictable while
 * per-cell truncation guarantees the table never destabilizes the frame. */
export function renderTableBlock(
  header: readonly string[], rows: readonly (readonly string[])[], width: number,
  align: readonly ('left' | 'center' | 'right' | null)[] = [],
): string[] {
  const columns = Math.max(1, header.length, ...rows.map((row) => row.length));
  const borders = columns + 1;
  const padding = columns * 2;
  const cellWidth = Math.max(3, Math.floor((Math.max(width, borders + padding + columns * 3) - borders - padding) / columns));
  const row = (cells: readonly string[], heading = false): string => `│${Array.from({ length: columns }, (_, index) => {
    const rendered = renderInlineMarkdown(cells[index] ?? '');
    const clipped = visibleSlice(rendered, cellWidth);
    const remaining = Math.max(0, cellWidth - terminalCellWidth(clipped));
    const left = align[index] === 'right' ? remaining : align[index] === 'center' ? Math.floor(remaining / 2) : 0;
    const padded = `${' '.repeat(left)}${clipped}${' '.repeat(remaining - left)}`;
    return ` ${heading ? chalk.bold(padded) : padded} `;
  }).join('│')}│`;
  const separator = `├${Array.from({ length: columns }, () => '─'.repeat(cellWidth + 2)).join('┼')}┤`;
  return [row(header, true), separator, ...rows.map((cells) => row(cells))].map((line) => visibleSlice(line, width));
}

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
  for (const token of tokens) {
    if (/^\u001b\[[0-9;]*m$/.test(token)) {
      rendered += token;
      sawAnsi = true;
      continue;
    }
    const tokenWidth = terminalCellWidth(token);
    if (renderedWidth + tokenWidth > available) break;
    rendered += token;
    renderedWidth += tokenWidth;
  }
  return `${rendered}${sawAnsi ? '\u001b[0m' : ''}…`;
}

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
  for (const match of value.matchAll(/\u001b\[[0-9;]*m/g)) {
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
function sliceToWidth(value: string, width: number): string {
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
  const plain = value.replace(/\u001b\[[0-9;]*m/g, '');
  let width = 0;
  for (const { segment } of graphemes.segment(plain)) {
    if (segment === '\t') { width += TAB_WIDTH - (width % TAB_WIDTH); continue; }
    // Other control characters occupy no cell (and are stripped before paint).
    if (segment.length === 1 && /[\u0000-\u001f\u007f-\u009f]/.test(segment)) continue;
    // The base character decides the cell count; whatever the cluster attaches
    // to it (marks, variation selectors, joiners) draws inside those cells.
    const base = String.fromCodePoint(segment.codePointAt(0) ?? 0);
    if (/\p{Mark}/u.test(base)) continue;
    width += isWideCodePoint(base.codePointAt(0) ?? 0) ? 2 : 1;
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

export interface ComposerLayout {
  rows: string[];
  cursorRow: number;
  cursorWidth: number;
}

/** Soft-wrap the composer like a normal terminal editor. The old horizontal
 * viewport hid the beginning of long prompts and made typing appear stuck on
 * one line; this preserves the whole nearby draft and exposes a real cursor
 * row for absolute-positioned TUI painting. */
export function composerLayout(value: string, cursor: number, available: number, maxRows = 6): ComposerLayout {
  const width = Math.max(1, available);
  const ranges: Array<{ start: number; end: number }> = [];
  let rowStart = 0;
  let lastWhitespaceStart: number | undefined;
  let lastWhitespaceEnd: number | undefined;
  let previousWasWhitespace = false;
  let column = 0;
  for (let index = 0; index < value.length;) {
    const next = nextCharacterIndex(value, index);
    const character = value.slice(index, next);
    if (character === '\n') {
      ranges.push({ start: rowStart, end: index });
      rowStart = next;
      column = 0;
      lastWhitespaceStart = undefined;
      lastWhitespaceEnd = undefined;
      previousWasWhitespace = false;
      index = next;
      continue;
    }
    const characterWidth = Math.max(1, terminalCellWidth(character));
    if (column > 0 && column + characterWidth > width) {
      if (/\s/u.test(character)) {
        ranges.push({ start: rowStart, end: index });
        rowStart = next;
        index = next;
      } else if (lastWhitespaceStart !== undefined && lastWhitespaceEnd !== undefined && lastWhitespaceEnd > rowStart) {
        ranges.push({ start: rowStart, end: lastWhitespaceStart });
        rowStart = lastWhitespaceEnd;
        index = rowStart;
      } else {
        ranges.push({ start: rowStart, end: index });
        rowStart = index;
      }
      column = 0;
      lastWhitespaceStart = undefined;
      lastWhitespaceEnd = undefined;
      previousWasWhitespace = false;
      continue;
    }
    column += characterWidth;
    if (/\s/u.test(character)) {
      if (!previousWasWhitespace) lastWhitespaceStart = index;
      lastWhitespaceEnd = next;
      previousWasWhitespace = true;
    } else {
      previousWasWhitespace = false;
    }
    index = next;
  }
  ranges.push({ start: rowStart, end: value.length });
  const rows = ranges.map(({ start, end }) => value.slice(start, end));
  let position = { row: Math.max(0, rows.length - 1), column: 0 };
  for (const [row, range] of ranges.entries()) {
    if (cursor < range.start) {
      position = { row, column: 0 };
      break;
    }
    if (cursor > range.end) continue;
    position = { row, column: terminalCellWidth(value.slice(range.start, cursor)) };
    // A soft-wrap boundary belongs to the following row so the cursor does
    // not remain visually stranded at the end of the previous full line.
    if (cursor === range.end && ranges[row + 1]?.start === cursor) continue;
    break;
  }
  const start = Math.max(0, Math.min(position.row - maxRows + 1, rows.length - maxRows));
  const visible = rows.slice(start, start + maxRows);
  return { rows: visible, cursorRow: position.row - start, cursorWidth: position.column };
}

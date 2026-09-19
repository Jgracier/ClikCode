/** Pure text/markdown rendering for the terminal UI -- header, bullet, and
 * inline (bold/italic/code/link) formatting, plus ANSI-cell-width-aware
 * word-wrapping and composer-viewport scrolling. Nothing here depends on
 * HarnessSession/HarnessState -- every function takes plain strings and
 * returns plain strings, so this is safe to import from anywhere without
 * pulling in the whole broker. */

import chalk from 'chalk';
import { Lexer, marked, type Token, type Tokens } from 'marked';
import type { MessageBlock } from './types.js';


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
export function renderInlineMarkdown(text: string): string {
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
}


/** Convert the original CommonMark/GFM block tree into the small semantic
 * document model used by the terminal. Code remains distinct from prose so
 * display-only continuation rows can preserve every byte without pretending
 * those visual wraps are source newlines. */
export function splitIntoBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const visit = (tokens: Token[], sourceEnd: number, quoteDepth = 0, listDepth = 0): void => {
    for (const token of tokens) {
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
          const content = (item.tokens ?? []).filter((child: Token) => child.type !== 'list');
          const nested = (item.tokens ?? []).filter((child: Token) => child.type === 'list');
          const first = content.map((child: Token) => 'text' in child && typeof child.text === 'string' ? child.text : '').filter(Boolean).join(' ');
          blocks.push({
            kind: 'list-item', text: first, depth: listDepth, ordered: list.ordered,
            ...(list.ordered ? { number: Number(list.start || 1) + index } : {}),
            task: item.task, ...(item.task ? { checked: item.checked } : {}), quoteDepth, sourceEnd,
          });
          visit(nested, sourceEnd, quoteDepth, listDepth + 1);
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
      continue;
    }
    const blockStart = blocks.length;
    visit([token], sourceEnd);
    // Compound Markdown tokens (notably lists and blockquotes) produce
    // several display blocks but have only one safe outer boundary. Prevent
    // an event whose offset is inside that construct from being emitted after
    // its first child and visually splitting the Markdown structure.
    for (let index = blockStart; index < blocks.length - 1; index++) blocks[index]!.sourceEnd = sourceStart;
  }
  return blocks;
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
  const tokens = value.match(/\u001b\[[0-9;]*m|./gu) ?? [];
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
  let remaining = value;
  while (remaining && terminalCellWidth(remaining) > safeWidth) {
    let cut = 0;
    for (const character of remaining) {
      if (terminalCellWidth(remaining.slice(0, cut + character.length)) > safeWidth) break;
      cut += character.length;
    }
    cut = Math.max(1, cut);
    rows.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  rows.push(remaining);
  return rows;
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

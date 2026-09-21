/** Markdown to terminal text: inline formatting, block parsing (including
 * the streaming parser that must not change a block's shape as the rest of
 * it arrives), and tables. */

import chalk from 'chalk';
import { Lexer, marked, type Token, type Tokens } from 'marked';
import type { MessageBlock } from '../../harness/prompter.js';
import { HYPERLINK_CLOSE, closeOpenHyperlink, hyperlinkOpen, linksOn } from './hyperlinks.js';
import { memoizeByText } from './memoize.js';
import { SAFE_LINK } from './text.js';
import { terminalCellWidth, visibleSlice } from './width.js';
import { wrapWords } from './wrap.js';

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
const renderInlineMarkdownWith = (text: string, hyperlinks: boolean): string => {
  type Style = (value: string) => string;
  const render = (tokens: Token[], styles: Style[] = []): string => tokens.map((token) => {
    const apply = (value: string, extra: Style[] = styles): string => styleWords(value, (word) => extra.reduce((result, style) => style(result), word));
    if (token.type === 'strong') return render(token.tokens ?? [], [...styles, chalk.bold]);
    if (token.type === 'em') return render(token.tokens ?? [], [...styles, chalk.italic]);
    if (token.type === 'del') return render(token.tokens ?? [], [...styles, chalk.strikethrough]);
    if (token.type === 'codespan') return apply(token.text, [...styles, chalk.cyan]);
    if (token.type === 'link') {
      const href = String(token.href ?? '');
      const label = render(token.tokens ?? [], [...styles, chalk.underline]);
      if (hyperlinks && SAFE_LINK.test(href)) {
        // One open/close pair per word, like the styling: a link that wraps
        // must not leave the hyperlink open across the row break.
        return styleWords(label, (word) => `${hyperlinkOpen(href)}${word}${HYPERLINK_CLOSE}`);
      }
      // An autolink's text is its target; printing it twice helps nobody.
      return token.text === href || `mailto:${token.text}` === href ? label : `${label} ${chalk.dim(`(${href})`)}`;
    }
    if (token.type === 'image') return `${chalk.magenta(`[image: ${token.text || 'attachment'}]`)} ${chalk.dim(`(${token.href})`)}`;
    if (token.type === 'br') return ' ';
    if ('tokens' in token && Array.isArray(token.tokens)) return render(token.tokens, styles);
    if ('text' in token && typeof token.text === 'string') return apply(token.text);
    return typeof token.raw === 'string' ? apply(token.raw) : '';
  }).join('');
  return render(Lexer.lexInline(text, { gfm: true, breaks: false }));
};

const renderInlineLinked = memoizeByText((text: string) => renderInlineMarkdownWith(text, true));

const renderInlinePlain = memoizeByText((text: string) => renderInlineMarkdownWith(text, false));

export const renderInlineMarkdown = (text: string): string => (linksOn() ? renderInlineLinked : renderInlinePlain)(text);

/** For the block that is still receiving tokens: same output, no cache entry. */
export const renderInlineMarkdownLive = (text: string): string => renderInlineMarkdownWith(text, linksOn());

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

/** Width-bounded GFM table rendering. Columns take their natural width when
 * the table fits and are shrunk proportionally when it does not; a cell that
 * is still too wide WRAPS inside its column. Truncating with an ellipsis threw
 * away exactly the long cells (paths, commands, descriptions) a table is
 * usually there to show. */
export function renderTableBlock(
  header: readonly string[], rows: readonly (readonly string[])[], width: number,
  align: readonly ('left' | 'center' | 'right' | null)[] = [],
): string[] {
  const columns = Math.max(1, header.length, ...rows.map((row) => row.length));
  const borders = columns + 1;
  const padding = columns * 2;
  const available = Math.max(columns * 3, width - borders - padding);
  const rendered = [header, ...rows].map((cells) => Array.from({ length: columns }, (_, index) => renderInlineMarkdown(cells[index] ?? '')));
  const natural = Array.from({ length: columns }, (_, index) => Math.max(3, ...rendered.map((cells) => terminalCellWidth(cells[index]!))));
  const longestWord = Array.from({ length: columns }, (_, index) => Math.max(3, ...rendered.map((cells) =>
    Math.max(0, ...cells[index]!.split(/\s+/).map((word) => terminalCellWidth(word))))));
  const widths = [...natural];
  // Take width from the widest column first, never below a column's longest
  // word while any other column still has slack to give.
  let excess = widths.reduce((sum, value) => sum + value, 0) - available;
  for (const floor of [longestWord, natural.map(() => 3)]) {
    while (excess > 0) {
      let widest = -1;
      for (let index = 0; index < columns; index++) {
        if (widths[index]! > floor[index]! && (widest === -1 || widths[index]! > widths[widest]!)) widest = index;
      }
      if (widest === -1) break;
      widths[widest]! -= 1;
      excess -= 1;
    }
  }
  const line = (cells: readonly string[], heading = false): string[] => {
    const wrapped = cells.map((cell, index) => wrapWords(cell, widths[index]!));
    const height = Math.max(1, ...wrapped.map((lines) => lines.length));
    return Array.from({ length: height }, (_, lineIndex) => `│${wrapped.map((lines, index) => {
      const text = lines[lineIndex] ?? '';
      const remaining = Math.max(0, widths[index]! - terminalCellWidth(text));
      const left = align[index] === 'right' ? remaining : align[index] === 'center' ? Math.floor(remaining / 2) : 0;
      const padded = `${' '.repeat(left)}${text}${' '.repeat(remaining - left)}`;
      return ` ${heading ? chalk.bold(padded) : padded} `;
    }).join('│')}│`);
  };
  const separator = `├${widths.map((columnWidth) => '─'.repeat(columnWidth + 2)).join('┼')}┤`;
  return [...line(rendered[0]!, true), separator, ...rendered.slice(1).flatMap((cells) => line(cells))]
    .map((row) => closeOpenHyperlink(visibleSlice(row, width)));
}

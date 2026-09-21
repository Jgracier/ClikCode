/** Parsed Markdown blocks to transcript rows. Append-only: a row written here
 * lands in the terminal's own scrollback once and is never addressed again. */

import chalk from 'chalk';
import { renderInlineMarkdown, renderInlineMarkdownLive, renderTableBlock } from './markdown.js';
import { terminalCellWidth } from './width.js';
import { wrapCodeLine, wrapWords } from './wrap.js';
import type { MessageBlock } from '../../harness/types.js';

/** Rows for a run of parsed Markdown blocks, exactly as they appear in the
 * transcript.
 *
 * Append-only: a row this returns is written into the terminal's own
 * scrollback once and never addressed again, so the same blocks must produce
 * the same rows whether they are rendered while an answer streams or when its
 * persisted copy arrives. `firstOfMessage` puts the message's marker on the
 * very first row; every later row is indented under it. `live` renders the
 * final block with the streaming inline renderer, whose output does not change
 * shape as the rest of a construct arrives.
 */
export function renderMessageBlocks(
  blocks: readonly MessageBlock[], marker: string, width: number, firstOfMessage = true, live = false,
): string[] {
  const rows: string[] = [];
  let firstLine = firstOfMessage;
  const linePrefix = (): string => {
    const prefix = firstLine ? `${marker} ` : '  ';
    firstLine = false;
    return prefix;
  };
  for (const [index, block] of blocks.entries()) {
    const streaming = live && index === blocks.length - 1;
    // Blocks are separated by an empty row -- a paragraph, a list, a fence and
    // the paragraph after it are separate things and read as one wall of text
    // without it. Consecutive items of the same list are not separated: a list
    // is one thing. The separator belongs to the block that FOLLOWS, never to
    // the one before it: a row handed to scrollback can never grow a row, and
    // a streaming answer's blocks are handed over as each one closes.
    // A run that continues a message (firstOfMessage false) is separated from
    // whatever the earlier run wrote for the same reason.
    const previous = index ? blocks[index - 1] : undefined;
    const tight = previous?.kind === 'list-item' && block.kind === 'list-item';
    if ((previous || !firstOfMessage) && !tight) rows.push('');
    const quotePrefix = block.quoteDepth ? chalk.dim('│ '.repeat(block.quoteDepth)) : '';
    if (block.kind === 'code') {
      const structural = `${quotePrefix}${'  '.repeat(block.indent)}`;
      for (const codeLine of [...(block.language ? [chalk.dim(`[${block.language}]`)] : []), ...block.lines]) {
        const segments = wrapCodeLine(codeLine, Math.max(1, width - terminalCellWidth(structural) - 2));
        for (const [segmentIndex, segment] of segments.entries()) {
          const continuation = segmentIndex ? chalk.dim('↳ ') : '  ';
          rows.push(`${linePrefix()}${structural}${continuation}${chalk.cyan(segment)}`);
        }
      }
      continue;
    }
    if (block.kind === 'table') {
      const available = Math.max(1, width - terminalCellWidth(quotePrefix));
      for (const tableLine of renderTableBlock(block.header, block.rows, available, block.align)) {
        rows.push(`${linePrefix()}${quotePrefix}${tableLine}`);
      }
      continue;
    }
    if (block.kind === 'rule') {
      const available = Math.max(1, width - terminalCellWidth(quotePrefix));
      rows.push(`${linePrefix()}${quotePrefix}${chalk.dim('─'.repeat(available))}`);
      continue;
    }
    const listPrefix = block.kind === 'list-item'
      ? `${'  '.repeat(block.depth)}${block.task ? chalk.cyan(block.checked ? '☑' : '☐') : block.ordered ? chalk.dim(`${block.number}.`) : chalk.dim('•')} `
      : block.kind === 'paragraph' ? '  '.repeat(block.indent) : '';
    const structural = `${quotePrefix}${listPrefix}`;
    const hangIndent = ' '.repeat(terminalCellWidth(structural));
    const text = block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'list-item' ? block.text : '';
    // The block still receiving tokens has a new text on every frame; the
    // streaming renderer keeps an unterminated span from reflowing later.
    const styled = (streaming ? renderInlineMarkdownLive : renderInlineMarkdown)(text || ' ');
    const budget = Math.max(1, width - terminalCellWidth(structural));
    for (const [lineIndex, line] of wrapWords(styled, budget).entries()) {
      const indentation = lineIndex === 0 ? structural : hangIndent;
      rows.push(`${linePrefix()}${indentation}${block.kind === 'heading'
        ? block.level <= 2 ? chalk.cyanBright(chalk.bold(line)) : chalk.bold(line)
        : line}`);
    }
  }
  return rows;
}

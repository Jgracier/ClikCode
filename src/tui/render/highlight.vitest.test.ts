import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { highlightLines, highlightsLanguage, type HighlightSpan } from './highlight';
import { createStreamingBlockParser, splitIntoBlocks } from './markdown';
import { renderMessageBlocks } from './message-blocks';
import { TurnTranscript } from '../../turn/transcript';

/** `kind:text` for every coloured span of one line. */
const kinds = (spans: readonly HighlightSpan[]): string[] => spans.filter((span) => span.kind).map((span) => `${span.kind}:${span.text}`);

describe('highlighting a fence', () => {
  it('tells keywords, strings, numbers, calls, types and comments apart', () => {
    const [line] = highlightLines(['export const total: number = sum(items, 42); // done'], 'ts');
    expect(kinds(line!)).toEqual(['keyword:export', 'keyword:const', 'type:number', 'function:sum', 'number:42', 'comment:// done']);
    expect(line!.map((span) => span.text).join('')).toBe('export const total: number = sum(items, 42); // done');
    expect(kinds(highlightLines(['def run(self, path="a.txt"):'], 'python')[0]!)).toEqual(['keyword:def', 'function:run', 'constant:self', 'string:"a.txt"']);
    expect(kinds(highlightLines(['  "name": "demo", "count": 3, "ok": true'], 'json')[0]!)).toEqual(['property:"name"', 'string:"demo"', 'property:"count"', 'number:3', 'property:"ok"', 'constant:true']);
    expect(kinds(highlightLines(['export DIR=$HOME/x "q" # where'], 'bash')[0]!)).toEqual(['keyword:export', 'property:$HOME', 'string:"q"', 'comment:# where']);
    expect(kinds(highlightLines(['SELECT id FROM users WHERE name = \'x\''], 'sql')[0]!)).toEqual(['keyword:SELECT', 'keyword:FROM', 'keyword:WHERE', 'string:\'x\'']);
    expect(highlightLines(['+added', '-removed', '@@ -1 +1 @@'], 'diff').map((spans) => spans[0]!.kind)).toEqual(['inserted', 'deleted', 'meta']);
    expect(kinds(highlightLines(['<div class="a">hi</div>'], 'html')[0]!)).toEqual(['tag:<div', 'attribute:class', 'string:"a"', 'tag:>', 'tag:</div>']);
  });

  it('carries a comment or a string from one line to the next', () => {
    const lines = highlightLines(['/* start', 'still comment */ let x = `a', 'b`;'], 'js');
    expect(lines[1]![0]).toEqual({ text: 'still comment */', kind: 'comment' });
    expect(lines[2]![0]).toEqual({ text: 'b`', kind: 'string' });
    // The lines above, given as `before`, decide the same.
    expect(highlightLines(['still comment */ let x = 1'], 'js', ['/* start'])[0]![0]).toEqual({ text: 'still comment */', kind: 'comment' });
  });

  it('leaves a language it does not know alone', () => {
    expect(highlightsLanguage('ts')).toBe(true);
    expect(highlightsLanguage('brainfuck')).toBe(false);
    expect(highlightLines(['+++.'], 'brainfuck')).toEqual([[{ text: '+++.' }]]);
  });
});

describe('a highlighted fence on the terminal', () => {
  const level = chalk.level;
  beforeAll(() => { chalk.level = 1; });
  afterAll(() => { chalk.level = level; });

  it('colours by kind on the terminal\'s own palette, even across a wrapped row', () => {
    const rows = renderMessageBlocks(splitIntoBlocks('```ts\nconst greeting = "a long string that wraps";\n```'), '·', 30);
    expect(rows[1]).toContain(chalk.magenta('const'));
    expect(rows[1]).toContain(chalk.green('"a long str'));
    // Wrapped: the string carries on, still green, on the next row.
    expect(rows[2]).toContain('↳');
    expect(rows[2]).toContain(chalk.green('ing that wraps"'));
  });

  it('writes a fence streamed a line at a time exactly as its saved copy', () => {
    const answer = 'Here:\n\n```ts\n/* a comment\n   over lines */\nconst s = `multi\nline`;\nfunction f() { return 1; }\n```\n\nDone.';
    const render = (blocks: Parameters<typeof renderMessageBlocks>[0], first: boolean) => renderMessageBlocks(blocks, '·', 60, first);
    const transcript = new TurnTranscript();
    const parse = createStreamingBlockParser();
    const rows: string[] = [];
    for (let end = 1; end <= answer.length; end += 1) {
      const content = answer.slice(0, end);
      rows.push(...transcript.advance({ content, blocks: parse(content), tools: [], turnEnded: false, renderBlocks: render }).finished);
    }
    rows.push(...transcript.advance({ content: answer, blocks: parse(answer), tools: [], turnEnded: true, renderBlocks: render }).finished);
    expect(rows).toEqual(renderMessageBlocks(splitIntoBlocks(answer), '·', 60));
  });
});

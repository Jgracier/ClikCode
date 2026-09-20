import { describe, expect, it } from 'vitest';
import { TurnTranscript, settledAnswerBlocks, settledToolRows } from './turn-transcript';
import type { MessageBlock } from './types.js';

const text = (blocks: readonly MessageBlock[]): string[] =>
  blocks.map((block) => (block as { text?: string }).text ?? `[${block.kind}]`);

describe('an answer settles a block at a time', () => {
  it('holds the final block back while it can still grow', () => {
    const first = settledAnswerBlocks('One.\n\nTwo is still bei', 0, false);
    expect(text(first.settled)).toEqual(['One.']);
    expect(text(first.live)).toEqual(['Two is still bei']);
  });

  it('emits each block exactly once as the answer grows', () => {
    let emitted = 0;
    const seen: string[] = [];
    for (const content of ['One.', 'One.\n\nTwo.', 'One.\n\nTwo.\n\nThree.']) {
      const step = settledAnswerBlocks(content, emitted, false);
      seen.push(...text(step.settled));
      emitted = step.emitted;
    }
    expect(seen, 'a block was emitted twice or skipped').toEqual(['One.', 'Two.']);
  });

  it('settles the trailing block when the turn ends', () => {
    // Without this the last paragraph of every answer is stranded in the live
    // region and never reaches scrollback.
    const step = settledAnswerBlocks('One.\n\nThe last word.', 1, true);
    expect(text(step.settled)).toEqual(['The last word.']);
    expect(step.live).toEqual([]);
  });

  it('never re-emits when a re-extracted answer comes back shorter', () => {
    // nativeTurnResult re-derives the answer from complete stdout, so it
    // routinely differs in length from what streamed. A shorter answer must
    // not make already-retired blocks look unemitted.
    const step = settledAnswerBlocks('One.', 3, true);
    expect(step.settled).toEqual([]);
    expect(step.emitted).toBe(1);
  });
});

describe('a tool settles when it finishes', () => {
  const tool = (id: string, done: boolean) => ({ id, done, lines: [`${done ? 'done' : 'tool'} ${id}`] });

  it('keeps a running tool live and retires a finished one', () => {
    const step = settledToolRows([tool('a', true), tool('b', false)], new Set(), false);
    expect(step.settled).toEqual(['done a']);
    expect(step.live).toEqual(['tool b']);
    expect(step.emitted).toEqual(['a']);
  });

  it('never emits the same tool twice', () => {
    const step = settledToolRows([tool('a', true)], new Set(['a']), false);
    expect(step.settled).toEqual([]);
    expect(step.live).toEqual([]);
  });

  it('settles a tool that never reported completion when the turn ends', () => {
    // Some vendors simply never send one. Holding the region open for it is
    // what pinned a whole turn above the composer.
    const step = settledToolRows([tool('stuck', false)], new Set(), true);
    expect(step.settled).toEqual(['tool stuck']);
    expect(step.live).toEqual([]);
  });

  it('keeps every tool in a long run, with no count row', () => {
    const many = Array.from({ length: 200 }, (_, index) => tool(`t${index}`, true));
    const step = settledToolRows(many, new Set(), false);
    expect(step.settled).toHaveLength(200);
    expect(step.settled.join('\n')).not.toContain('earlier tool');
  });
});

describe('a tool lands where it happened', () => {
  // These rules moved here from responseTimeline, which placed tools in a
  // rebuilt conversation. Nothing rebuilds one any more, so the placement is
  // decided once, as a row settles, and never revisited.
  const renderBlocks = (blocks: readonly MessageBlock[]): string[] => text(blocks);
  const run = (content: string, tools: Parameters<TurnTranscript['advance']>[0]['tools']): string[] =>
    new TurnTranscript().advance({ content, tools, turnEnded: true, renderBlocks }).finished;

  it('keeps tool activity at the response offset where it occurred', () => {
    expect(run('I will inspect it.\n\nThe issue is fixed.', [
      { id: 'a', done: true, responseOffset: 19, lines: ['tool read file'] },
      { id: 'b', done: true, responseOffset: 19, lines: ['done read file'] },
    ])).toEqual(['I will inspect it.', 'tool read file', 'done read file', 'The issue is fixed.']);
  });

  it('waits for a complete compound block before inserting a tool', () => {
    // An offset inside a nested list belongs after the whole list: cutting a
    // compound construct in half would re-parse its halves independently.
    expect(run('- parent\n  - child\n- sibling\n\nAfter.', [
      { id: 'a', done: true, responseOffset: 12, lines: ['tool inspect'] },
    ])).toEqual(['parent', 'child', 'sibling', 'tool inspect', 'After.']);
  });

  it('keeps a whole tool-only burst rather than collapsing it to a count', () => {
    // The count row changed every time another tool ran, and a row that can
    // still change cannot enter native scrollback -- so it pinned itself, and
    // everything after it, above the composer for the rest of the turn.
    const tools = Array.from({ length: 12 }, (_, index) => ({
      id: `t${index}`, done: true, responseOffset: 0, lines: [`done Read(file${index}.ts)`],
    }));
    const rows = run('Done.', tools);
    expect(rows).toEqual([...tools.flatMap((tool) => tool.lines), 'Done.']);
    expect(rows.join('\n')).not.toContain('earlier tool');
  });

  it('applies no response-wide budget when tools sit in separate blocks', () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index}.`);
    let offset = 0;
    const tools = paragraphs.map((paragraph, index) => {
      offset += paragraph.length;
      const tool = { id: `t${index}`, done: true, responseOffset: offset, lines: [`done tool ${index}`] };
      offset += 2;
      return tool;
    });
    const rows = run(paragraphs.join('\n\n'), tools);
    expect(rows.filter((row) => row.startsWith('done tool '))).toHaveLength(12);
    expect(rows.join('\n')).not.toContain('earlier tool');
    expect(rows.at(-1)).toBe('done tool 11');
  });

  it('appends a tool that completes after the prose around it settled', () => {
    // Append-only: a row is written where it became final. A tool that reports
    // completion three paragraphs later cannot be inserted back up the page.
    const transcript = new TurnTranscript();
    const tool = { id: 'slow', responseOffset: 0, lines: ['done slow tool'] };
    const first = transcript.advance({
      content: 'One.\n\nTwo.\n\n', tools: [{ ...tool, done: false }], turnEnded: false, renderBlocks,
    });
    expect(first.finished).toEqual(['One.', 'Two.']);
    const second = transcript.advance({
      content: 'One.\n\nTwo.\n\nThree.', tools: [{ ...tool, done: true }], turnEnded: true, renderBlocks,
    });
    expect(second.finished).toEqual(['done slow tool', 'Three.']);
  });
});

describe('an open code fence retires a line at a time', () => {
  const renderBlocks = (blocks: readonly MessageBlock[]): string[] =>
    blocks.flatMap((block) => (block.kind === 'code'
      ? [...(block.language ? [`[${block.language}]`] : []), ...block.lines] : text([block])));

  it('writes every completed line once, and the header once', () => {
    // A fence taller than the viewport could never retire its head rows while
    // the block itself was unfinished, and the live region cannot be taller
    // than the terminal.
    const transcript = new TurnTranscript();
    const lines = Array.from({ length: 6 }, (_, index) => `line ${index}`);
    const finished: string[] = [];
    let live: string[] = [];
    for (let count = 1; count <= lines.length; count += 1) {
      const step = transcript.advance({
        content: `\`\`\`ts\n${lines.slice(0, count).join('\n')}\n`, tools: [], turnEnded: false, renderBlocks,
      });
      finished.push(...step.finished);
      live = step.live;
    }
    const closed = transcript.advance({
      content: `\`\`\`ts\n${lines.join('\n')}\n\`\`\`\n\nDone.`, tools: [], turnEnded: true, renderBlocks,
    });
    finished.push(...closed.finished);
    expect(live).toEqual(['line 5']);
    expect(finished).toEqual(['[ts]', ...lines, 'Done.']);
  });
});

describe('a whole turn', () => {
  const renderBlocks = (blocks: readonly MessageBlock[]): string[] => text(blocks);

  it('retires prose and tools once each, in the order they happened', () => {
    const transcript = new TurnTranscript();
    const finished: string[] = [];

    let live = transcript.advance({
      content: 'Let me look.\n\n', tools: [], turnEnded: false, renderBlocks,
    });
    finished.push(...live.finished);

    live = transcript.advance({
      content: 'Let me look.\n\n',
      tools: [{ id: 'a', done: true, lines: ['done Read(alpha.ts)'] }],
      turnEnded: false, renderBlocks,
    });
    finished.push(...live.finished);

    live = transcript.advance({
      content: 'Let me look.\n\nFound it.',
      tools: [{ id: 'a', done: true, lines: ['done Read(alpha.ts)'] }],
      turnEnded: true, renderBlocks,
    });
    finished.push(...live.finished);

    expect(finished).toEqual(['Let me look.', 'done Read(alpha.ts)', 'Found it.']);
    expect(live.live, 'something was left live after the turn ended').toEqual([]);
  });

  it('starts clean for the next turn', () => {
    const transcript = new TurnTranscript();
    transcript.advance({ content: 'First answer.', tools: [], turnEnded: true, renderBlocks });
    transcript.reset();
    const next = transcript.advance({ content: 'Second answer.', tools: [], turnEnded: true, renderBlocks });
    expect(next.finished).toEqual(['Second answer.']);
  });
});

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

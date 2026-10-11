import { describe, expect, it } from 'vitest';
import { TurnTranscript, settledAnswerBlocks } from './transcript';
import type { MessageBlock } from '../harness/prompter.js';
import { createStreamingBlockParser, splitIntoBlocks } from '../tui/render/markdown.js';
import { renderMessageBlocks } from '../tui/render/message-blocks.js';

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
  // The settling rule is owned by TurnTranscript itself; these drive it
  // through advance(), the real production path, rather than through a
  // standalone helper that only tests ever called.
  const renderBlocks = (blocks: readonly MessageBlock[]): string[] => text(blocks);
  const tool = (id: string, done: boolean) =>
    ({ id, done, responseOffset: 0, lines: [`${done ? 'done' : 'tool'} ${id}`] });

  it('keeps a running tool live and retires a finished one', () => {
    const step = new TurnTranscript().advance({
      content: '', tools: [tool('a', true), tool('b', false)], turnEnded: false, renderBlocks,
    });
    expect(step.finished).toEqual(['done a']);
    expect(step.live).toEqual(['tool b']);
  });

  it('never emits the same tool twice', () => {
    const transcript = new TurnTranscript();
    const first = transcript.advance({
      content: '', tools: [tool('a', true)], turnEnded: false, renderBlocks,
    });
    expect(first.finished).toEqual(['done a']);
    const second = transcript.advance({
      content: '', tools: [tool('a', true)], turnEnded: false, renderBlocks,
    });
    expect(second.finished).toEqual([]);
    expect(second.live).toEqual([]);
  });

  it('settles a tool that never reported completion when the turn ends', () => {
    // Some vendors simply never send one. Holding the region open for it is
    // what pinned a whole turn above the composer.
    const step = new TurnTranscript().advance({
      content: '', tools: [tool('stuck', false)], turnEnded: true, renderBlocks,
    });
    expect(step.finished).toEqual(['tool stuck']);
    expect(step.live).toEqual([]);
  });

  it('keeps every tool in a long run, with no count row', () => {
    const many = Array.from({ length: 200 }, (_, index) => tool(`t${index}`, true));
    const step = new TurnTranscript().advance({
      content: '', tools: many, turnEnded: false, renderBlocks,
    });
    expect(step.finished).toHaveLength(200);
    expect(step.finished.join('\n')).not.toContain('earlier tool');
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
    // The tool began inside 'One.', so the prose after it waits (it was
    // generated after the call began); what was already written stays.
    const tool = { id: 'slow', responseOffset: 'One.'.length, lines: ['done slow tool'] };
    const first = transcript.advance({
      content: 'One.\n\nTwo.\n\n', tools: [{ ...tool, done: false }], turnEnded: false, renderBlocks,
    });
    expect(first.finished).toEqual(['One.']);
    const second = transcript.advance({
      content: 'One.\n\nTwo.\n\nThree.', tools: [{ ...tool, done: true }], turnEnded: true, renderBlocks,
    });
    expect(second.finished).toEqual(['done slow tool', 'Two.', 'Three.']);
  });
});

describe('an open code fence retires a line at a time', () => {
  const renderBlocks = (blocks: readonly MessageBlock[]): string[] =>
    blocks.flatMap((block) => (block.kind === 'code'
      ? [...(block.language && !block.headerless ? [`[${block.language}]`] : []), ...block.lines] : text([block])));

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

describe('a tool call closes the prose before it', () => {
  it('settles a paragraph that no blank line ever closed', () => {
    const content = 'Right, I will check the tests and report back.';
    const streaming = settledAnswerBlocks(content, 0, false);
    expect(streaming.settled, 'a growing paragraph is still live').toHaveLength(0);
    expect(streaming.live).toHaveLength(1);

    const closed = settledAnswerBlocks(content, 0, false, undefined, true);
    expect(closed.settled, 'a paragraph a tool call followed is final').toHaveLength(1);
    expect(closed.live).toHaveLength(0);
  });

  it('leaves prose written after the tool call live', () => {
    const transcript = new TurnTranscript();
    const first = transcript.advance({
      content: 'Checking the tests.',
      tools: [{ id: 't1', done: true, lines: ['  Bash(npx vitest run)'], responseOffset: 'Checking the tests.'.length }],
      turnEnded: false,
      renderBlocks: text,
    });
    expect(first.finished.join('\n')).toContain('Checking the tests.');
    expect(first.finished.join('\n')).toContain('Bash(npx vitest run)');
    expect(first.live.join('\n')).not.toContain('Checking the tests.');

    const second = transcript.advance({
      content: 'Checking the tests.\n\nThey pass, still writing',
      tools: [{ id: 't1', done: true, lines: ['  Bash(npx vitest run)'], responseOffset: 'Checking the tests.'.length }],
      turnEnded: false,
      renderBlocks: text,
    });
    expect(second.live.join('\n'), 'the sentence still being written is live').toContain('They pass, still writing');
    expect(second.finished.join('\n')).not.toContain('They pass, still writing');
  });

  it('keeps a running call where the settled row will be', () => {
    const transcript = new TurnTranscript();
    const offset = 'Checking the tests.'.length;
    const running = { id: 't1', done: false, lines: ['  spinner Bash'], responseOffset: offset };
    const first = transcript.advance({
      content: 'Checking the tests.', tools: [running], turnEnded: false, renderBlocks: text,
    });
    expect(first.finished.join('\n')).toContain('Checking the tests.');
    expect(first.live.join('\n')).toContain('spinner Bash');
    expect(first.finished.join('\n')).not.toContain('spinner');

    const second = transcript.advance({
      content: 'Checking the tests.\n\nThey pass, still writing',
      tools: [running], turnEnded: false, renderBlocks: text,
    });
    const live = second.live.join('\n');
    expect(live.indexOf('spinner Bash')).toBeGreaterThanOrEqual(0);
    expect(live.indexOf('spinner Bash')).toBeLessThan(live.indexOf('They pass'));

    const third = transcript.advance({
      content: 'Checking the tests.\n\nThey pass, still writing',
      tools: [{ ...running, done: true, lines: ['  done Bash'] }],
      turnEnded: false, renderBlocks: text,
    });
    expect(third.finished.join('\n')).toContain('done Bash');
    expect(third.live.join('\n')).toContain('They pass');
    expect(third.live.join('\n')).not.toContain('spinner');
    expect(third.live.join('\n')).not.toContain('done Bash');
  });
});

describe('a streamed answer lays out as its saved copy does', () => {
  // The real renderer: it opens every block after the first with a blank row,
  // which is what a block retired in pieces must write only once.
  const render = (blocks: readonly MessageBlock[], first: boolean): string[] => renderMessageBlocks(blocks, '·', 40, first);
  const streamed = (answer: string, step: number): string[] => {
    const transcript = new TurnTranscript();
    const parse = createStreamingBlockParser();
    const rows: string[] = [];
    for (let end = step; end < answer.length + step; end += step) {
      const content = answer.slice(0, Math.min(end, answer.length));
      rows.push(...transcript.advance({ content, blocks: parse(content), tools: [], turnEnded: false, renderBlocks: render }).finished);
    }
    rows.push(...transcript.advance({ content: answer, blocks: parse(answer), tools: [], turnEnded: true, renderBlocks: render }).finished);
    return rows;
  };
  const answers = {
    'a fence after a list': '## Heading\n\n- a\n- b\n\n```ts\nexport function m(a: number) {\n  return a;\n}\n```\n\ndone',
    'a nested list, a quote and a table': 'Intro paragraph that is long enough to wrap across more than one row.\n\n1. one\n2. two\n   - nested\n3. three\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nEnd.',
    'a blank line inside a fence': 'Text then fence\n```py\nprint(1)\n\nprint(2)\n```\nafter',
    'a fence inside a list item': '- item\n\n  ```sh\n  ls\n  ```\n- next\n\n---\n\n### Sub\n\nbye',
  };
  for (const [name, answer] of Object.entries(answers)) {
    it(`writes ${name} with no extra or missing rows, however it is chunked`, () => {
      const saved = renderMessageBlocks(splitIntoBlocks(answer), '·', 40);
      for (const step of [1, 2, 3, 5, 7, 11, 30]) expect(streamed(answer, step), `chunks of ${step}`).toEqual(saved);
    });
  }
});

describe('parallel calls keep the order they started in', () => {
  const t = (id: string, done: boolean, responseOffset: number, extra: Record<string, unknown> = {}) =>
    ({ id, done, responseOffset, lines: [`${done ? 'done' : 'run'} ${id}`], ...extra });

  it('does not retire a finished call above an earlier one still running', () => {
    const transcript = new TurnTranscript();
    const first = transcript.advance({
      content: '', tools: [t('X', false, 0, { seq: 1 }), t('Y', true, 0, { seq: 2 })], turnEnded: false, renderBlocks: text,
    });
    expect(first.finished, 'Y was written above the still-running X').toEqual([]);
    expect(first.live).toEqual(['run X', 'done Y']);
    const second = transcript.advance({
      content: '', tools: [t('X', true, 0, { seq: 1 }), t('Y', true, 0, { seq: 2 })], turnEnded: false, renderBlocks: text,
    });
    expect(second.finished).toEqual(['done X', 'done Y']);
    expect(second.live).toEqual([]);
  });

  it('orders by arrival when no seq is given, and by seq when it is', () => {
    const step = new TurnTranscript().advance({
      content: '', tools: [t('late', true, 0, { seq: 9 }), t('early', true, 0, { seq: 3 })], turnEnded: false, renderBlocks: text,
    });
    expect(step.finished).toEqual(['done early', 'done late']);
  });

  it('lets a running sub-agent stay open without holding later calls back', () => {
    const step = new TurnTranscript().advance({
      content: '', tools: [t('agent', false, 0, { seq: 1, agent: true }), t('Y', true, 0, { seq: 2 })],
      turnEnded: false, renderBlocks: text,
    });
    expect(step.finished).toEqual(['done Y']);
    expect(step.live).toEqual(['run agent']);
  });

  it('retires everything at the end of the turn, running or not', () => {
    const step = new TurnTranscript().advance({
      content: '', tools: [t('X', false, 0, { seq: 1 }), t('Y', true, 0, { seq: 2 })], turnEnded: true, renderBlocks: text,
    });
    expect(step.finished).toEqual(['run X', 'done Y']);
  });

  it('holds prose written after a running call until the call settles', () => {
    const transcript = new TurnTranscript();
    const content = 'Starting.\n\nMore text written while it runs.\n\nAnd more.\n\nTail';
    const running = t('X', false, 'Starting.'.length, { seq: 1 });
    const first = transcript.advance({ content, tools: [running], turnEnded: false, renderBlocks: text });
    expect(first.finished, 'prose generated after the call was retired above its row').toEqual(['Starting.']);
    expect(first.live).toEqual(['run X', 'More text written while it runs.', 'And more.', 'Tail']);
    const second = transcript.advance({ content, tools: [{ ...running, done: true, lines: ['done X'] }], turnEnded: false, renderBlocks: text });
    expect(second.finished).toEqual(['done X', 'More text written while it runs.', 'And more.']);
    expect(second.live).toEqual(['Tail']);
  });

  it('does not hold prose behind a running sub-agent', () => {
    const step = new TurnTranscript().advance({
      content: 'Go.\n\nWhile it runs.\n\nTail', tools: [t('A', false, 3, { agent: true, seq: 1 })], turnEnded: false, renderBlocks: text,
    });
    expect(step.finished).toEqual(['Go.', 'While it runs.']);
  });
});

describe('a table is not drawn narrower than it will end up', () => {
  const render = (blocks: readonly MessageBlock[], first: boolean): string[] => renderMessageBlocks(blocks, '·', 60, first);
  it('holds an open table live until it closes', () => {
    const answer = '| name | n |\n|---|---|\n| a | 1 |\n| b | 2 |\n| c | 3 |\n| a much wider cell than before | 4 |\n\nDone.';
    const transcript = new TurnTranscript();
    const parse = createStreamingBlockParser();
    const rows: string[] = [];
    for (let end = 6; end < answer.length; end += 6) {
      const content = answer.slice(0, end);
      const step = transcript.advance({ content, blocks: parse(content), tools: [], turnEnded: false, renderBlocks: render });
      rows.push(...step.finished);
      if (end > 40 && end < 60) expect(step.finished.filter((row) => row.includes('|') || row.includes('│')), 'table rows retired while open').toEqual([]);
    }
    rows.push(...transcript.advance({ content: answer, blocks: parse(answer), tools: [], turnEnded: true, renderBlocks: render }).finished);
    expect(rows).toEqual(renderMessageBlocks(splitIntoBlocks(answer), '·', 60));
  });
});

describe('a steer acknowledged inside a block', () => {
  // The observed bug: a steer's offset was the length of the prose so far, so
  // it closed the block still being written and the block was retired
  // truncated ("Step one of the long"); its tail then never appeared live and
  // was written again, under a second copy of the steer, when the turn ended.
  const renderBlocks = (blocks: readonly MessageBlock[]): string[] => text(blocks);
  const steer = (offset: number) => ({ id: 'steer#1', done: true, steer: true, responseOffset: offset, lines: ['> steer'] });

  it('does not close the block it fell inside, and waits for it', () => {
    const transcript = new TurnTranscript();
    const first = transcript.advance({ content: 'Step one of the long', tools: [steer(20)], turnEnded: false, renderBlocks });
    expect(first.finished).toEqual([]);
    expect(first.live).toContain('> steer');
    const second = transcript.advance({ content: 'Step one of the long job.\n\nStep two', tools: [steer(20)], turnEnded: false, renderBlocks });
    expect(second.finished, 'the block is retired whole, then the steer').toEqual(['Step one of the long job.', '> steer']);
    const third = transcript.advance({ content: 'Step one of the long job.\n\nStep two.', tools: [steer(20)], turnEnded: true, renderBlocks });
    expect(third.finished).toEqual(['Step two.']);
  });

  it('is placed at once when it fell at a block boundary', () => {
    const step = new TurnTranscript().advance({ content: 'One.\n\n', tools: [steer(6)], turnEnded: false, renderBlocks });
    expect(step.finished).toEqual(['One.', '> steer']);
  });

  it('still settles when the turn ends inside the block', () => {
    const step = new TurnTranscript().advance({ content: 'Cut off mid', tools: [steer(5)], turnEnded: true, renderBlocks });
    expect(step.finished).toEqual(['Cut off mid', '> steer']);
  });
});

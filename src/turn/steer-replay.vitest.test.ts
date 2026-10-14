/** Standard 1.5 and 11: a steer sits where the live view put it -- after the
 * block it fell inside -- so a reopened chat reads like the one that ran. */
import { describe, expect, it } from 'vitest';
import { beginPendingTurn, finishPendingTurn, recordPendingSteer, sessionTranscriptMessages, updatePendingResponse } from './checkpoint.js';
import { TurnTranscript } from './transcript.js';
import { splitIntoBlocks } from '../tui/render/markdown.js';
import type { MessageBlock } from '../harness/prompter.js';
import type { HarnessSession } from '../session/model.js';

const stamp = (second: number): string => `2026-01-02T00:00:${String(second).padStart(2, '0')}.000Z`;
const STEER = '<<steer>>';

function session(): HarnessSession {
  return {
    id: 'session', route: 'local', accountId: null, provider: 'openai', model: null,
    effort: 'medium', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', messages: [],
  };
}

/** A block as one comparable row: what it says, whichever kind it is. */
const blockRows = (blocks: readonly MessageBlock[]): string[] => blocks.map((block) => {
  if (block.kind === 'code') return `code:${block.lines.join('\n')}`;
  if (block.kind === 'table') return `table:${block.header.join('|')}`;
  if (block.kind === 'rule') return 'rule';
  return `${block.kind}:${block.text}`;
});

/** The rows the live view settles for an answer with a steer at `offset`. */
function liveRows(answer: string, offset: number): string[] {
  return new TurnTranscript().advance({
    content: answer,
    tools: [{ id: 'steer', done: true, steer: true, lines: [STEER, ''], responseOffset: offset, seq: 1 }],
    turnEnded: true,
    renderBlocks: blockRows,
  }).finished;
}

/** The rows a reopened chat draws for the same turn: each saved message
 * through the same transcript the prompter draws a saved message with. */
function replayRows(answer: string, offset: number): string[] {
  const target = session();
  beginPendingTurn(target, 'Work', stamp(0));
  updatePendingResponse(target, answer, 'append', stamp(1));
  recordPendingSteer(target, 'also this', stamp(2), offset, stamp(2), 'steer-1', 1);
  finishPendingTurn(target, undefined, stamp(3));
  return sessionTranscriptMessages(target).slice(1).flatMap((message) => (message.role === 'user' ? [STEER, '']
    : new TurnTranscript().advance({ content: message.content, tools: [], turnEnded: true, renderBlocks: blockRows }).finished));
}

const ANSWERS = [
  'One sentence. Another in the same block.\n\nSecond paragraph, longer than the first.\n\nThird.',
  'Intro:\n\n- first item\n- second item\n- third item\n\nAfter the list.',
  'Before.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter the fence.',
  '# Heading\n\nBody under it, with several words in it.',
  'Just one paragraph with no break at all in it',
];

describe('a steer in a reopened chat sits where the live view put it', () => {
  for (const answer of ANSWERS) {
    it(`for every offset of ${JSON.stringify(answer.slice(0, 24))}`, () => {
      for (let offset = 0; offset <= answer.length; offset += 1) {
        expect(replayRows(answer, offset), `steer at ${offset}`).toEqual(liveRows(answer, offset));
      }
    });
  }

  it('never splits an answer mid-sentence', () => {
    const answer = 'Looking at the parser now. It has two passes.\n\nThen the lexer.';
    const target = session();
    beginPendingTurn(target, 'Work', stamp(0));
    updatePendingResponse(target, answer, 'append', stamp(1));
    recordPendingSteer(target, 'use bun', stamp(2), 'Looking at the parser now. It'.length, stamp(2), 's', 1);
    const [, first, steer, rest] = sessionTranscriptMessages(target);
    expect(first!.content).toBe('Looking at the parser now. It has two passes.\n\n');
    expect(steer).toMatchObject({ role: 'user', content: 'use bun' });
    expect(rest!.content).toBe('Then the lexer.');
  });
});

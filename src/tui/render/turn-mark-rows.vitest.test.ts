import { describe, expect, it } from 'vitest';
import { thoughtRow } from '../../harness/protocol/turn-flow.js';
import { savedTurnRanks, turnMarkLines } from './turn-mark-rows.js';
import type { TurnMark } from '../../session/model.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const call = (responseOffset: number, seq?: number) => ({ responseOffset, event: { ...(seq === undefined ? {} : { seq }) } });
const thought = (seq: number, responseOffset: number): TurnMark => ({ kind: 'thought', id: `t${seq}`, seq, responseOffset, durationMs: 1000 });

describe('the shared thought row', () => {
  it('says the duration, and the heading when the model wrote one', () => {
    expect(thoughtRow({ durationMs: 4200 })).toBe('Thought for 4s');
    expect(thoughtRow({ durationMs: 300, heading: 'Inspecting the parser' })).toBe('Thought for 1s · Inspecting the parser');
  });
});

describe('a saved turn\'s rows', () => {
  it('words each kind of mark', () => {
    expect(turnMarkLines({ kind: 'outcome', id: 'o', seq: 1, responseOffset: 0, outcome: 'approved', label: 'make' }).map(strip)).toEqual(['✓ approved make']);
    expect(turnMarkLines({ kind: 'notice', id: 'n', seq: 1, responseOffset: 0, message: 'Switched' }).map(strip)).toEqual(['Switched']);
    expect(turnMarkLines({ kind: 'plan', id: 'p', seq: 1, responseOffset: 0, entries: [{ content: 'a', status: 'completed' }, { content: 'b' }] }).map(strip))
      .toEqual(['Plan · 1/2 done', '☑ a', '☐ b']);
  });

  it('orders by the worker seq where every row has one', () => {
    // A thought that began after the call at the same offset, and one before it.
    const ranks = savedTurnRanks([call(5, 2)], [thought(1, 5), thought(3, 5)]);
    expect(ranks).toEqual({ activities: [2], marks: [1, 3] });
  });

  it('never mixes the worker seq with a position: a turn with calls that have none keeps recorded order', () => {
    const ranks = savedTurnRanks([call(5), call(5)], [thought(1, 5)]);
    expect(ranks).toEqual({ activities: [1, 2], marks: [3] });
  });
});

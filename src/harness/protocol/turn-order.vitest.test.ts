import { describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../prompter.js';
import { markBefore, mergeActivity, orderMarks, withChildTool } from './activity-view.js';

describe('turn order (standard 1)', () => {
  it('orders by offset, then by the sequence the worker assigned -- never by completion', () => {
    const rows = [
      { name: 'steer', responseOffset: 10, seq: 5 },
      { name: 'caused-by-steer', responseOffset: 10, seq: 6 },
      { name: 'before-steer', responseOffset: 10, seq: 4 },
      { name: 'earlier-text', responseOffset: 3, seq: 9 },
    ];
    expect(orderMarks(rows, (row) => row).map((row) => row.name)).toEqual(['earlier-text', 'before-steer', 'steer', 'caused-by-steer']);
  });

  it('reads a turn saved without sequences in the order it was recorded', () => {
    const rows = [
      { name: 'b', responseOffset: 7 }, { name: 'a', responseOffset: 7 }, { name: 'first', responseOffset: 0 },
    ];
    expect(orderMarks(rows, (row) => row).map((row) => row.name)).toEqual(['first', 'b', 'a']);
  });

  it('puts a steer with no sequence after the rows at its offset, as before', () => {
    expect(markBefore({ responseOffset: 4 }, { responseOffset: 4 })).toBe(true);
    expect(markBefore({ responseOffset: 4, seq: 9 }, { responseOffset: 4, seq: 3 })).toBe(false);
    expect(markBefore({ responseOffset: 5, seq: 1 }, { responseOffset: 4, seq: 3 })).toBe(false);
  });

  it('keeps the first sequence when frames of one call merge', () => {
    const start: HarnessActivityEvent = { kind: 'tool-start', label: 'Read a', id: 'r', seq: 3 };
    expect(mergeActivity(start, { kind: 'tool-done', label: 'Read a', id: 'r', seq: 11 }).seq).toBe(3);
  });
});

describe("a sub-agent's tool uses (standard 5)", () => {
  it('counts unique child call ids, not the frames each call arrives in', () => {
    let agent: HarnessActivityEvent = { kind: 'tool-start', label: 'Task(look)', id: 'agent', agent: true };
    // Claude: block start, block stop with its input, the completed record.
    for (const id of ['c1', 'c1', 'c1', 'c2', 'c2', 'c2']) agent = withChildTool(agent, { kind: 'tool-start', id });
    expect(agent.childTools).toBe(2);
  });

  it('keeps the counted ids across the parent\'s own later frames, and saves only the number', () => {
    let agent: HarnessActivityEvent = { kind: 'tool-start', label: 'Task(look)', id: 'agent', agent: true };
    agent = withChildTool(agent, { kind: 'tool-start', id: 'c1' });
    agent = mergeActivity(agent, { kind: 'tool-start', label: 'Task(look)', id: 'agent' });
    agent = withChildTool(agent, { kind: 'tool-start', id: 'c1' });
    expect(agent.childTools).toBe(1);
    expect(JSON.parse(JSON.stringify(agent))).toEqual({ kind: 'tool-start', label: 'Task(look)', id: 'agent', agent: true, childTools: 1 });
  });
});

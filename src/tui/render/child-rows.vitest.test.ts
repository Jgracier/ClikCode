/** A running sub-agent's calls: one slot each, placed under the parent and
 * never above text emitted before them (standard section 5). */
import { describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../../harness/prompter.js';
import { TurnTranscript, type SettlingTool } from '../../turn/transcript';
import { CHILDREN_SHOWN, LiveChildren } from './child-rows';

const ev = (kind: HarnessActivityEvent['kind'], id: string, label = id): HarnessActivityEvent =>
  ({ kind, id, label, parentId: 'P' } as HarnessActivityEvent);
let seq = 100;
const at = (offset: number) => ({ offset, seq: ++seq });

describe('every concurrent child has its own slot', () => {
  it('one child finishing leaves the others live', () => {
    const children = new LiveChildren();
    children.apply(ev('tool-start', 'c0'), at(0));
    children.apply(ev('tool-start', 'c1'), at(0));
    children.apply(ev('tool-done', 'c1'), at(0));
    expect(children.rows([{ id: 'P', offset: 0, seq: 1 }]).map((row) => row.label)).toEqual(['c0']);
  });

  it('shows only the last three live children of a parent', () => {
    const children = new LiveChildren();
    for (const id of ['a', 'b', 'c', 'd', 'e']) children.apply(ev('tool-start', id), at(0));
    expect(children.rows([{ id: 'P', offset: 0, seq: 1 }]).map((row) => row.label)).toEqual(['c', 'd', 'e']);
    expect(CHILDREN_SHOWN).toBe(3);
  });

  it('counts a call once however many frames it sends', () => {
    const children = new LiveChildren();
    expect(children.apply(ev('tool-start', 'a'), at(0)).counted).toBe(true);
    expect(children.apply(ev('tool-start', 'a'), at(0)).counted).toBe(false);
    expect(children.apply(ev('tool-start', 'b'), at(0)).counted).toBe(true);
  });

  it('clears a parent\'s children when it ends, and only that parent\'s', () => {
    const children = new LiveChildren();
    children.apply(ev('tool-start', 'a'), at(0));
    children.apply({ ...ev('tool-start', 'z'), parentId: 'Q' }, at(0));
    children.parentEnded('P');
    expect(children.rows([{ id: 'P', offset: 0, seq: 1 }, { id: 'Q', offset: 0, seq: 2 }]).map((row) => row.label)).toEqual(['z']);
  });
});

describe('a child is never drawn above text emitted before it', () => {
  const asTool = (row: ReturnType<LiveChildren['rows']>[number]): SettlingTool =>
    ({ id: row.id, done: false, agent: true, responseOffset: row.offset, seq: row.seq, lines: [`    child ${row.label}`] });

  it('puts a late child below the parent\'s later text, an early one directly under the parent', () => {
    const children = new LiveChildren();
    const text = 'Spawning.\n\nCharlie text WHILE agent runs.\n\n';
    children.apply(ev('tool-start', 'c0'), at(9)); // began with the parent
    children.apply(ev('tool-start', 'c1'), at(text.length)); // began after Charlie's text
    const agent: SettlingTool = { id: 'P', done: false, agent: true, responseOffset: 9, seq: 1, lines: ['agent P'] };
    const rows = children.rows([{ id: 'P', offset: 9, seq: 1 }]).map(asTool);
    const step = new TurnTranscript().advance({
      content: text, tools: [agent, ...rows], turnEnded: false, renderBlocks: (blocks) => blocks.map((block) => (block as { text?: string }).text ?? ''),
    });
    const all = [...step.finished, ...step.live];
    // The agent row is a long-lived container: it stays drawn while text
    // that came after it retires, and its first child hangs directly under it.
    expect(all.indexOf('    child c0')).toBe(all.indexOf('agent P') + 1);
    expect(all.indexOf('Charlie text WHILE agent runs.'), 'a child that began after the text sat above it')
      .toBeLessThan(all.indexOf('    child c1'));
    expect(all.indexOf('agent P')).toBeLessThan(all.indexOf('    child c1'));
  });
});

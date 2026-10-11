import { describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { commandOutputPreview, diffPreview, DIFF_PREVIEW_LINES, outputPreview } from '../harness/protocol/activity-view.js';
import type { TurnActivity } from '../session/model.js';
import { activitiesBetween, boundTurnActivities, MAX_CHILDREN_PER_PARENT, MAX_OUTPUT_LINES, MAX_TURN_ACTIVITY_BYTES, readTurnActivities, recordTurnActivity, runningTurnActivity, textTranscript } from './turn-activities.js';

const lines = (count: number, prefix = 'line'): string[] => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

describe('a turn\'s calls, as kept', () => {
  it('merges the frames of one call into one record placed where it began', () => {
    let calls: TurnActivity[] = [];
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: '$ npm test', id: 'a', category: 'run' }, 10);
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: '$ npm test', id: 'a', output: ['one'] }, 20);
    calls = recordTurnActivity(calls, { kind: 'tool-done', label: 'tool', id: 'a', exitCode: 0 }, 30);
    expect(calls).toEqual([{ responseOffset: 10, event: { kind: 'tool-done', label: '$ npm test', id: 'a', category: 'run', output: ['one'], exitCode: 0 } }]);
  });

  it('keeps a sub-agent\'s completed work for recovery while counting it on the parent row', () => {
    let calls: TurnActivity[] = [];
    calls = recordTurnActivity(calls, { kind: 'thinking', label: 'hmm' }, 0);
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: 'Task(look)', id: 'agent' }, 0);
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: 'Read(a.ts)', id: 'c1', parentId: 'agent' }, 0);
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: 'Read(b.ts)', id: 'c2', parentId: 'agent' }, 0);
    calls = recordTurnActivity(calls, { kind: 'tool-done', label: 'tool', id: 'c1', parentId: 'agent', output: ['found important result'] }, 0);
    expect(calls.map((call) => call.event.label)).toEqual(['Task(look)', 'Read(a.ts)', 'Read(b.ts)']);
    expect(calls[0]!.event.childTools).toBe(2);
    expect(calls[1]!.event).toMatchObject({ kind: 'tool-done', parentId: 'agent', output: ['found important result'] });
    expect(runningTurnActivity(calls)?.id).toBe('agent');
  });

  it('keeps a long command\'s head and tail, so its row reads the same', () => {
    const event: HarnessActivityEvent = { kind: 'tool-done', label: '$ build', id: 'b', category: 'run', output: lines(500) };
    const [kept] = recordTurnActivity([], event, 0);
    expect(kept!.event.output).toHaveLength(MAX_OUTPUT_LINES);
    expect(commandOutputPreview(kept!.event)).toEqual(commandOutputPreview(event));
    expect(outputPreview(kept!.event, 3)).toEqual(outputPreview(event, 3));
  });

  it('keeps the start of other output, counting the rest', () => {
    const event: HarnessActivityEvent = { kind: 'tool-done', label: 'Grep(x)', id: 'g', category: 'search', output: lines(300) };
    const [kept] = recordTurnActivity([], event, 0);
    expect(kept!.event.output).toEqual(lines(MAX_OUTPUT_LINES));
    expect(outputPreview(kept!.event, 8)).toEqual(outputPreview(event, 8));
  });

  it('bounds a diff by lines, with what was left out counted', () => {
    const diff = [{ path: 'a.ts', additions: 400, removals: 0, lines: lines(400).map((text) => ({ kind: 'added' as const, text })) }];
    const [kept] = recordTurnActivity([], { kind: 'tool-done', label: 'Edit a.ts', id: 'e', diff }, 0);
    expect(kept!.event.diff![0]!.lines).toHaveLength(200);
    const shown = (files: Parameters<typeof diffPreview>[0]) => {
      const preview = diffPreview(files, DIFF_PREVIEW_LINES);
      return { lines: preview.files.map((file) => file.lines), hidden: preview.hiddenLines, more: preview.moreFiles };
    };
    expect(shown(kept!.event.diff!)).toEqual(shown(diff));
  });

  it('bounds a whole turn by size, not by count: every call of a long one is kept', () => {
    let calls: TurnActivity[] = [];
    for (let index = 0; index < 600; index += 1) {
      calls = recordTurnActivity(calls, { kind: 'tool-done', label: `$ step ${index}`, id: `s${index}`, category: 'run', output: lines(40, `output of step ${index}`) }, index);
    }
    expect(JSON.stringify(calls).length).toBeLessThanOrEqual(MAX_TURN_ACTIVITY_BYTES);
    expect(calls).toHaveLength(600);
    expect(calls[0]!.event.label).toBe('$ step 0');
    // The newest is as it arrived; the oldest kept only what its row needs.
    expect(calls.at(-1)!.event.output).toHaveLength(40);
    expect(calls[0]!.event.output!.length).toBeLessThan(40);
  });

  it('drops the oldest calls only when their rows alone are too much', () => {
    const many = Array.from({ length: 50 }, (_, index): TurnActivity => ({ event: { kind: 'tool-done', label: `$ ${'x'.repeat(300)} ${index}`, id: `${index}` }, responseOffset: 0 }));
    const kept = boundTurnActivities(many, 4000);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(4000);
    expect(kept.at(-1)!.event.id).toBe('49');
    expect(kept.length).toBeLessThan(50);
  });

  it('reads anything stored without throwing', () => {
    expect(readTurnActivities(undefined)).toEqual([]);
    expect(readTurnActivities('nope')).toEqual([]);
    expect(readTurnActivities([null, 3, { event: { kind: 'bogus', label: 'x' } }, { event: { kind: 'tool-done', label: 'ok' } }], 5))
      .toEqual([{ event: { kind: 'tool-done', label: 'ok' }, responseOffset: 5 }]);
  });

  it('tells a text-only reader what a turn without text did', () => {
    expect(textTranscript([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', activities: [{ event: { kind: 'tool-done', label: '$ make' }, responseOffset: 0 }, { event: { kind: 'tool-error', label: '$ make test' }, responseOffset: 0 }] },
      { role: 'assistant', content: 'Done.', activities: [{ event: { kind: 'tool-done', label: '$ ls' }, responseOffset: 0 }] },
      { role: 'assistant', content: '  ' },
    ])).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Tool calls: $ make; $ make test (failed).' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });
});

describe('a sub-agent in the journal (standards 1, 2, 5)', () => {
  it("counts the sub-agent's unique child calls, however many frames each arrived in", () => {
    let calls: TurnActivity[] = [];
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: 'Task(look)', id: 'agent', agent: true }, 0);
    for (const id of ['c1', 'c1', 'c1', 'c2', 'c2', 'c2']) {
      calls = recordTurnActivity(calls, { kind: 'tool-start', label: `Read(${id})`, id, parentId: 'agent' }, 0);
    }
    expect(calls[0]!.event.childTools).toBe(2);
    // Saved: the number only.
    expect(JSON.parse(JSON.stringify(calls[0]))).toEqual({ responseOffset: 0, event: { kind: 'tool-start', label: 'Task(look)', id: 'agent', agent: true, childTools: 2 } });
  });

  it("does not let a long sub-agent's children evict its parent or the turn's own rows", () => {
    let calls: TurnActivity[] = [];
    for (let index = 0; index < 5; index += 1) {
      calls = recordTurnActivity(calls, { kind: 'tool-done', label: `$ main ${index}`, id: `m${index}`, category: 'run', output: lines(30) }, index);
    }
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: 'Task(big)', id: 'agent', agent: true }, 9);
    for (let index = 0; index < 2000; index += 1) {
      calls = recordTurnActivity(calls, { kind: 'tool-start', label: `Read(f${index})`, id: `c${index}`, parentId: 'agent' }, 9);
      calls = recordTurnActivity(calls, { kind: 'tool-done', label: `Read(f${index})`, id: `c${index}`, parentId: 'agent', output: lines(60, `body ${index}`) }, 9);
    }
    const parents = calls.filter((call) => !call.event.parentId).map((call) => call.event.label);
    expect(parents).toEqual(['$ main 0', '$ main 1', '$ main 2', '$ main 3', '$ main 4', 'Task(big)']);
    const children = calls.filter((call) => call.event.parentId === 'agent');
    expect(children.length).toBe(MAX_CHILDREN_PER_PARENT);
    // The newest are the ones kept, and the count still says how many there were.
    expect(children.at(-1)!.event.id).toBe('c1999');
    expect(calls.find((call) => call.event.id === 'agent')!.event.childTools).toBe(2000);
    expect(JSON.stringify(calls).length).toBeLessThanOrEqual(MAX_TURN_ACTIVITY_BYTES);
  });

  it('past the size bound drops a sub-agent\'s children before any row of the turn', () => {
    const rows: TurnActivity[] = [
      ...Array.from({ length: 6 }, (_, index): TurnActivity => ({ event: { kind: 'tool-done', label: `$ ${'m'.repeat(200)} ${index}`, id: `m${index}` }, responseOffset: index })),
      { event: { kind: 'tool-start', label: 'Task(x)', id: 'a', agent: true, childTools: 30 }, responseOffset: 6 },
      ...Array.from({ length: 30 }, (_, index): TurnActivity => ({ event: { kind: 'tool-done', label: `Read ${'c'.repeat(200)} ${index}`, id: `c${index}`, parentId: 'a' }, responseOffset: 6 })),
    ];
    const kept = boundTurnActivities(rows, 2600);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(2600);
    expect(kept.filter((call) => !call.event.parentId)).toHaveLength(7);
  });

  it('keeps the first sequence a row was given when its later frames merge', () => {
    let calls: TurnActivity[] = [];
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: '$ x', id: 'a', seq: 4 }, 0);
    calls = recordTurnActivity(calls, { kind: 'tool-done', label: '$ x', id: 'a', seq: 9 }, 0);
    expect(calls[0]!.event.seq).toBe(4);
  });
});

describe('a steer splits a turn by (offset, seq) (standard 1.5)', () => {
  const call = (id: string, responseOffset: number, seq?: number): TurnActivity => ({ event: { kind: 'tool-done', label: id, id, ...(seq === undefined ? {} : { seq }) }, responseOffset });

  it('puts a row the steer caused after it, at the same offset', () => {
    const rows = [call('before', 10, 1), call('caused', 10, 3)];
    const steer = { responseOffset: 10, seq: 2 };
    expect(activitiesBetween(rows, 0, 10, 10, true, undefined, steer.seq).map((row) => row.event.id)).toEqual(['before']);
    expect(activitiesBetween(rows, 10, undefined, 5, false, steer.seq).map((row) => row.event.id)).toEqual(['caused']);
  });

  it('keeps the order saved turns were always drawn in: rows at a steer\'s offset go before it', () => {
    const rows = [call('a', 10), call('b', 10)];
    expect(activitiesBetween(rows, 0, 10, 10, true).map((row) => row.event.id)).toEqual(['a', 'b']);
    expect(activitiesBetween(rows, 10, undefined, 5, false)).toEqual([]);
  });
});

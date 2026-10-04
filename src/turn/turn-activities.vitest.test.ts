import { describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { commandOutputPreview, diffPreview, DIFF_PREVIEW_LINES, outputPreview } from '../harness/protocol/activity-view.js';
import type { TurnActivity } from '../session/model.js';
import { boundTurnActivities, MAX_TURN_ACTIVITY_BYTES, readTurnActivities, recordTurnActivity, textTranscript } from './turn-activities.js';

const lines = (count: number, prefix = 'line'): string[] => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

describe('a turn\'s calls, as kept', () => {
  it('merges the frames of one call into one record placed where it began', () => {
    let calls: TurnActivity[] = [];
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: '$ npm test', id: 'a', category: 'run' }, 10);
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: '$ npm test', id: 'a', output: ['one'] }, 20);
    calls = recordTurnActivity(calls, { kind: 'tool-done', label: 'tool', id: 'a', exitCode: 0 }, 30);
    expect(calls).toEqual([{ responseOffset: 10, event: { kind: 'tool-done', label: '$ npm test', id: 'a', category: 'run', output: ['one'], exitCode: 0 } }]);
  });

  it('never keeps a thought, and counts a sub-agent\'s calls on its row', () => {
    let calls: TurnActivity[] = [];
    calls = recordTurnActivity(calls, { kind: 'thinking', label: 'hmm' }, 0);
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: 'Task(look)', id: 'agent' }, 0);
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: 'Read(a.ts)', id: 'c1', parentId: 'agent' }, 0);
    calls = recordTurnActivity(calls, { kind: 'tool-start', label: 'Read(b.ts)', id: 'c2', parentId: 'agent' }, 0);
    expect(calls.map((call) => [call.event.label, call.event.childTools])).toEqual([['Task(look)', 2]]);
  });

  it('keeps a long command\'s head and tail, so its row reads the same', () => {
    const event: HarnessActivityEvent = { kind: 'tool-done', label: '$ build', id: 'b', category: 'run', output: lines(500) };
    const [kept] = recordTurnActivity([], event, 0);
    expect(kept!.event.output).toHaveLength(40);
    expect(commandOutputPreview(kept!.event)).toEqual(commandOutputPreview(event));
    expect(outputPreview(kept!.event, 3)).toEqual(outputPreview(event, 3));
  });

  it('keeps the start of other output, counting the rest', () => {
    const event: HarnessActivityEvent = { kind: 'tool-done', label: 'Grep(x)', id: 'g', category: 'search', output: lines(300) };
    const [kept] = recordTurnActivity([], event, 0);
    expect(kept!.event.output).toEqual(lines(40));
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

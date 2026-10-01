/** A tool's output as its row shows it: while it runs and once it settles. */
import { describe, expect, it } from 'vitest';
import { outputPreviewRows, renderActivityLine } from '../../harness/protocol/activity-line.js';
import { activityLifecyclePhase, upsertActivityEvent } from './activity-log.js';

const plain = (rows: string[]) => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, '').trim());

describe('tool output previews', () => {
  it("shows a command's last lines and counts the earlier ones above them", () => {
    expect(plain(outputPreviewRows({ kind: 'tool-done', label: '$ npm test', category: 'run', output: ['a', 'b', 'c', 'd'] }, 3)))
      .toEqual(['… 1 earlier line', 'b', 'c', 'd']);
  });
  it('counts what a producer dropped from a kept tail', () => {
    expect(plain(outputPreviewRows({ kind: 'tool-start', label: 'x', output: ['y', 'z'], outputTail: true, outputOmitted: 40 }, 3)))
      .toEqual(['… 40 earlier lines', 'y', 'z']);
  });
  it('shows the first lines of anything else and counts the rest below', () => {
    expect(plain(outputPreviewRows({ kind: 'tool-done', label: 'grep', category: 'search', output: ['1', '2', '3', '4'], outputOmitted: 10 }, 3)))
      .toEqual(['1', '2', '3', '… 11 more lines']);
  });
  it('never shows a truncation marker as a line of output or a diff', () => {
    const rows = plain(renderActivityLine({ kind: 'tool-done', label: '$ ls', category: 'run', output: ['one'] }));
    expect(rows.filter((row) => row.includes('more line') || row.includes('earlier line'))).toEqual([]);
  });
});

describe('a running tool that settles', () => {
  it('keeps the output it streamed when the completion carries none', () => {
    let entries = upsertActivityEvent([], 0, 0, { kind: 'tool-start', label: '$ npm test', category: 'run', id: 't', output: ['passed 1', 'passed 2'], outputTail: true }, 1);
    entries = upsertActivityEvent(entries, 0, 0, { kind: 'tool-done', label: 'tool', id: 't' }, 2);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toMatchObject({ kind: 'tool-done', label: '$ npm test', output: ['passed 1', 'passed 2'], outputTail: true });
  });
  it('keeps naming the call in the status line when a progress frame has no name', () => {
    const started = activityLifecyclePhase(new Map(), { kind: 'tool-start', label: '$ npm test', category: 'run', id: 't' });
    const progressed = activityLifecyclePhase(started.activeTools, { kind: 'tool-start', label: 'tool', id: 't', output: ['x'] });
    expect(progressed.phase).toBe(started.phase);
    expect(progressed.category).toBe('run');
  });
});

describe('an approval with a change to review', () => {
  it('shows the change as the same numbered, coloured hunks a finished edit shows', async () => {
    const { approvalBlockRows } = await import('./approval-block.js');
    const { eventDiff } = await import('../../agent/line-diff.js');
    const rows = plain(approvalBlockRows(
      { title: 'Approve Edit a.ts', detail: '/w/a.ts', preview: { diff: eventDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n', { path: '/w/a.ts', numbered: true }) } },
      80, 20, { guarded: false, needsFocus: false, focused: true, queued: 0 },
    ));
    expect(rows).toEqual(expect.arrayContaining(['1   one', '2 - two', '2 + TWO', '3   three']));
  });
});

describe('a turn saved or sent by an older build', () => {
  // Before 2026-10-01 a diff was { removed, added }. Opening a conversation
  // replays its saved tool rows through upsertActivityEvent, and a worker
  // still on the older build sends that shape live: `.map` on it threw
  // "event.diff.map is not a function" and the chat would not open.
  it('opens, its edit drawn from the old shape', () => {
    const legacy = { kind: 'tool-done', label: 'Edit a.ts', category: 'edit', id: 'x', diff: { removed: ['old line'], added: ['new line'] } } as unknown as Parameters<typeof upsertActivityEvent>[3];
    const entries = upsertActivityEvent([], 0, 0, legacy, 1);
    expect(plain(entries[0]!.lines)).toEqual(['◆ Edit a.ts +1 -1', '- old line', '+ new line']);
  });
});

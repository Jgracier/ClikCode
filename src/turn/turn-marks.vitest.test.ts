import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessSession, OpenThought, TurnMark } from '../session/model.js';
import { MarkSequencer, MAX_TURN_MARKS, readTurnMarks, settledThought, stepThought, THOUGHT_MARK_CHARS, upsertMark } from './turn-marks.js';

describe('MarkSequencer: one number per row, assigned once', () => {
  it('gives every frame of a call the number its first frame got, whatever finishes first', () => {
    const sequencer = new MarkSequencer();
    const a = sequencer.seqFor({ kind: 'tool-start', label: 'Read a', id: 'a' });
    const b = sequencer.seqFor({ kind: 'tool-start', label: 'Read b', id: 'b' });
    const bDone = sequencer.seqFor({ kind: 'tool-done', label: 'tool', id: 'b' });
    const aDone = sequencer.seqFor({ kind: 'tool-done', label: 'tool', id: 'a' });
    expect([a, b, bDone, aDone]).toEqual([1, 2, 2, 1]);
  });

  it('numbers an id-less call by its open label, as frames merge', () => {
    const sequencer = new MarkSequencer();
    const start = sequencer.seqFor({ kind: 'tool-start', label: '$ ls' });
    expect(sequencer.seqFor({ kind: 'tool-start', label: '$ ls' })).toBe(start);
    expect(sequencer.seqFor({ kind: 'tool-done', label: 'tool' })).toBe(start);
    expect(sequencer.seqFor({ kind: 'tool-start', label: '$ ls' })).toBe(start + 1);
  });

  it('keeps a run of id-less thinking frames one row, and a notice ends it', () => {
    const sequencer = new MarkSequencer();
    const first = sequencer.seqFor({ kind: 'thinking', label: 'a' });
    expect(sequencer.seqFor({ kind: 'thinking', label: 'ab' })).toBe(first);
    sequencer.take();
    expect(sequencer.seqFor({ kind: 'thinking', label: 'c' })).toBeGreaterThan(first + 1);
  });

  it('stamps the event in place, so the next to see it has the same number', () => {
    const sequencer = new MarkSequencer();
    const event = { kind: 'tool-start' as const, label: 'x', id: 'x' };
    sequencer.stamp(event);
    expect(event).toMatchObject({ seq: 1 });
    expect(new MarkSequencer().stamp(event).seq).toBe(1);
  });
});

describe('thoughts', () => {
  const at = (offset: number, now: number) => ({ offset, now });

  it('accumulates one item, then settles it with its heading and duration when the next item starts', () => {
    let step = stepThought(undefined, [], { label: '**Reading the config** looking', id: 'r1', seq: 5 }, at(10, 1000));
    expect(step.thought).toMatchObject({ id: 'r1', seq: 5, responseOffset: 10, heading: 'Reading the config' });
    step = stepThought(step.thought, [], { label: '**Reading the config** looking at it more', id: 'r1', seq: 5 }, at(10, 2000));
    expect(step.mark).toBeUndefined();
    step = stepThought(step.thought, [], { label: 'second item', id: 'r2', seq: 7 }, at(40, 4500));
    expect(step.mark).toMatchObject({ kind: 'thought', id: 'thought:r1', seq: 5, responseOffset: 10, durationMs: 3500, heading: 'Reading the config' });
    expect(step.thought).toMatchObject({ id: 'r2', seq: 7, responseOffset: 40 });
  });

  it('merges a repeat of a settled item into its row instead of opening a second one below the answer', () => {
    const settled = settledThought({ id: 'r1', text: 'short', seq: 5, responseOffset: 10, startedAtMs: 0 }, 2000);
    const repeat = stepThought(undefined, [settled], { label: 'short and then the whole completed reasoning', id: 'r1', seq: 5 }, at(300, 9000));
    expect(repeat.thought).toBeUndefined();
    expect(repeat.mark).toMatchObject({ id: 'thought:r1', seq: 5, responseOffset: 10, durationMs: 2000, text: 'short and then the whole completed reasoning' });
    const same = stepThought(undefined, [settled], { label: 'short', id: 'r1', seq: 5 }, at(300, 9000));
    expect(same.unchanged).toBe(true);
  });

  it('caps the text and keeps the heading', () => {
    const open: OpenThought = { id: 'r', text: `**A heading here** ${'word '.repeat(2000)}`, seq: 1, responseOffset: 0, startedAtMs: 0 };
    const mark = settledThought(open, 5000);
    expect(mark).toMatchObject({ kind: 'thought', heading: 'A heading here', durationMs: 5000 });
    expect((mark as { text: string }).text.length).toBeLessThanOrEqual(THOUGHT_MARK_CHARS);
  });
});

describe('marks as kept', () => {
  const notice = (seq: number): TurnMark => ({ kind: 'notice', id: `notice:${seq}`, seq, responseOffset: 0, message: `n${seq}` });

  it('updates the plan in place and never drops it for notices', () => {
    let marks: TurnMark[] = upsertMark([], { kind: 'plan', id: 'plan', seq: 1, responseOffset: 4, entries: [{ content: 'a' }] });
    for (let index = 2; index < MAX_TURN_MARKS + 50; index += 1) marks = upsertMark(marks, notice(index));
    marks = upsertMark(marks, { kind: 'plan', id: 'plan', seq: 99999, responseOffset: 99999, entries: [{ content: 'a', status: 'completed' }] });
    expect(marks).toHaveLength(MAX_TURN_MARKS);
    expect(marks.find((mark) => mark.kind === 'plan')).toMatchObject({ seq: 1, responseOffset: 4, entries: [{ content: 'a', status: 'completed' }] });
  });

  it('strips terminal styling from a notice', () => {
    const [mark] = upsertMark([], { kind: 'notice', id: 'n', seq: 1, responseOffset: 0, message: '\u001b[33mCut off at its limit\u001b[39m' });
    expect(mark).toMatchObject({ message: 'Cut off at its limit' });
  });

  it('reads anything without throwing', () => {
    expect(readTurnMarks(undefined)).toEqual([]);
    expect(readTurnMarks([null, 4, { kind: 'notice' }, notice(3)])).toEqual([notice(3)]);
  });
});

describe('the journal records marks and numbers rows from one counter', () => {
  it('stamps calls, numbers a steer after them, and keeps what the observer hands it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-marks-'));
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = home;
    try {
      const { startTurnCheckpoint } = await import('./turn-journal.js');
      const target: HarnessSession = {
        id: randomUUID(), route: 'local', accountId: null, provider: 'openai', model: null, effort: 'medium',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', messages: [],
      };
      const checkpoint = await startTurnCheckpoint({ v: 1, sessions: [target], accounts: [] } as never, target, 'Go', {});
      const call = { kind: 'tool-start' as const, label: '$ ls', id: 'a' };
      checkpoint.activity(call);
      expect(call).toMatchObject({ seq: 1 });
      checkpoint.recordMark({ kind: 'notice', id: 'notice:2', seq: checkpoint.sequencer.take(), responseOffset: 0, message: 'hello' });
      await checkpoint.steer({ id: 's1', text: 'also', submittedAt: '2026-01-01T00:00:01.000Z' });
      expect(target.pendingTurn!.steers![0]!.seq).toBe(3);
      expect(checkpoint.steerOrder('s1')).toEqual({ seq: 3, responseOffset: 0 });
      expect(target.pendingTurn!.marks).toMatchObject([{ kind: 'notice', seq: 2, message: 'hello' }]);
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME;
      else process.env.CLIKCODE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });
});

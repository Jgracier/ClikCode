/** The turn-flow standard, second wave: what the worker now sends (seq, marks,
 * thought, phase, usage) wired into the extension's model and page logic. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { thoughtRow } from '../../../../src/harness/protocol/turn-flow';
import { applyEvent, emptyModel, turnMarks, turnNoticeNotes, type ChatModel } from '../../src/model';
import { workingStatus } from '../../src/webview/flow';
import type { HarnessSession, IdeEvent } from '../../src/protocol';

const session = (patch: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'opencode', model: 'opencode/big-pickle', effort: 'medium',
  permissionMode: 'ask', createdAt: '', updatedAt: '', status: 'active', nativeHarness: 'opencode',
  messages: [], ...patch,
});
const worker = (event: unknown): IdeEvent => ({ type: 'worker', sessionId: 's1', event } as IdeEvent);
const activity = (event: Record<string, unknown>): IdeEvent => worker({ type: 'activity', event });
const delta = (text: string): IdeEvent => worker({ type: 'delta', text, mode: 'append' });
const run = (events: IdeEvent[], start: ChatModel = emptyModel()): ChatModel => events.reduce(applyEvent, start);
const begin = (): ChatModel => run([
  { type: 'ready', version: '1', pid: 1 }, { type: 'session', session: session() },
  { type: 'turn-start', sessionId: 's1', prompt: 'hi' }, worker({ type: 'waiting-start', message: 'thinking' }),
]);

afterEach(() => { vi.useRealTimers(); });

describe('writing holds until a call starts (X1)', () => {
  const label = (model: ChatModel, now: number): string => workingStatus(model.live, false, now).label;

  it('still says writing a minute after the last word', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const model = run([delta('Let me explain')], begin());
    expect(label(model, 61_000)).toBe('Writing…');
  });

  it('goes back to thinking once a call started and finished after the text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    // All inside one millisecond: order is by event, not by the clock.
    const model = run([
      delta('Let me look'),
      activity({ kind: 'tool-start', id: 't1', label: 'Read a.ts', category: 'read' }),
      activity({ kind: 'tool-done', id: 't1', label: 'Read a.ts', category: 'read' }),
    ], begin());
    expect(label(model, 2_000)).toBe('Thinking…');
  });

  it('writes again when text arrives after the call', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const model = run([
      delta('Let me look'),
      activity({ kind: 'tool-start', id: 't1', label: 'Read a.ts', category: 'read' }),
      activity({ kind: 'tool-done', id: 't1', label: 'Read a.ts', category: 'read' }),
      delta(' and here it is'),
    ], begin());
    expect(label(model, 90_000)).toBe('Writing…');
  });

  it('a sub-agent\'s call is not a call of the turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const model = run([
      activity({ kind: 'tool-start', id: 'a1', label: 'Agent', agent: true }),
      delta('text'),
      activity({ kind: 'tool-start', id: 'c1', parentId: 'a1', label: 'Read x', category: 'read' }),
    ], begin());
    // The agent is still open, so the open call's verb leads; the point is that
    // the child did not move callAt.
    expect(model.live!.callAt).toBeLessThan(model.live!.writingAt!);
  });

  it('a window joining mid-answer says writing', () => {
    const model = run([
      worker({ type: 'snapshot', session: session(), live: { text: 'half an answ', waitingLabel: 'thinking' } }),
    ], begin());
    expect(label(model, Date.now() + 60_000)).toBe('Writing…');
  });
});

describe('the worker\'s seq is the order (X3)', () => {
  it('a call keeps the seq the worker gave it, not this window\'s count', () => {
    const model = run([activity({ kind: 'tool-start', id: 't1', label: 'Read a.ts', category: 'read', seq: 41 })], begin());
    expect(model.live!.activities[0]!.seq).toBe(41);
  });

  it('a row with none is numbered past everything the worker numbered', () => {
    const model = run([
      activity({ kind: 'tool-start', id: 't1', label: 'Read a.ts', category: 'read', seq: 41 }),
      activity({ kind: 'tool-start', id: 't2', label: 'Read b.ts', category: 'read' }),
    ], begin());
    expect(model.live!.activities.map((item) => item.seq)).toEqual([41, 42]);
  });

  it('a thought takes its place by the worker\'s seq', () => {
    const model = run([
      activity({ kind: 'thinking', id: 'r1', label: 'weighing', seq: 7 }),
      activity({ kind: 'tool-start', id: 't1', label: 'Read a.ts', category: 'read', seq: 8 }),
    ], begin());
    expect(model.live!.reasoning[0]!.seq).toBe(7);
    expect(model.live!.activities[0]!.seq).toBe(8);
  });

  it('a note and a plan take the seq and offset they were sent with', () => {
    const model = run([
      delta('abcdef'),
      worker({ type: 'note', message: 'Switched to work', seq: 12, responseOffset: 2 }),
      worker({ type: 'plan', entries: [{ content: 'one' }], seq: 13, responseOffset: 4 }),
    ], begin());
    expect(model.notes[0]).toMatchObject({ offset: 2, seq: 12, turn: 0 });
    expect(model.live!.planAt).toEqual({ offset: 4, seq: 13 });
  });

  it('a steer in a snapshot takes the seq the worker gave it', () => {
    const model = run([worker({
      type: 'snapshot', live: { text: 'abc', waitingLabel: 'thinking' },
      session: session({ pendingTurn: { prompt: 'hi', startedAt: '', steers: [{ text: 'one', responseOffset: 1, seq: 30 }] } as never }),
    })], begin());
    expect(model.live!.steers[0]).toMatchObject({ seq: 30, offset: 1 });
  });

  it('turnMarks orders by (offset, seq) with the shared comparator, whatever the kind', () => {
    const marks = turnMarks('abcdef',
      [{ key: 'b', kind: 'tool-done', label: 'y', offset: 3, seq: 20 }, { key: 'a', kind: 'tool-done', label: 'x', offset: 0, seq: 30 }],
      [{ text: 't', offset: 3, ms: 1000, seq: 10 }],
      [{ text: 's', offset: 3, seq: 15 }]);
    expect(marks.map((mark) => mark.activity?.key ?? (mark.thought ? 'thought' : 'steer'))).toEqual(['a', 'thought', 'steer', 'b']);
  });
});

describe('a window that attaches mid-turn draws what the worker holds (X4)', () => {
  const snapshot = (live: Record<string, unknown>, pendingTurn: Record<string, unknown> = {}): IdeEvent => worker({
    type: 'snapshot', session: session({ pendingTurn: { prompt: 'hi', startedAt: '', ...pendingTurn } as never }),
    live: { text: 'abcdefgh', waitingLabel: 'thinking', ...live },
  });
  const thoughtMark = { kind: 'thought', id: 'thought:r1', seq: 3, responseOffset: 2, durationMs: 4_200, heading: 'Reading the parser', text: 'looking at it' };
  const joined = (live: Record<string, unknown>): ChatModel => run([snapshot(live)], begin());

  it('shows the open thought', () => {
    const model = joined({ thought: { id: 'r2', text: 'weighing the options', seq: 5, responseOffset: 4, startedAt: 1_000 } });
    expect(model.live!.thought).toEqual({ id: 'r2', text: 'weighing the options' });
    expect(model.live!.thoughtStart).toEqual({ offset: 4, at: 1_000, seq: 5 });
  });

  it('shows settled thoughts with their heading and duration, in the worker\'s order', () => {
    const model = joined({ marks: [thoughtMark] });
    expect(model.live!.reasoning).toEqual([{ text: 'looking at it', heading: 'Reading the parser', offset: 2, ms: 4_200, seq: 3 }]);
  });

  it('puts the plan where the worker says it first appeared', () => {
    const model = joined({ marks: [{ kind: 'plan', id: 'plan', seq: 4, responseOffset: 5, entries: [{ content: 'one', status: 'in_progress' }] }] });
    expect(model.live!.planAt).toEqual({ offset: 5, seq: 4 });
    expect(model.plan).toEqual([{ content: 'one', status: 'in_progress' }]);
  });

  it('shows notices at their offsets, once however many snapshots come', () => {
    const notice = { kind: 'notice', id: 'notice:6', seq: 6, responseOffset: 3, message: 'Switched to work' };
    const model = run([snapshot({ marks: [notice] }), snapshot({ marks: [notice] })], begin());
    expect(model.notes.filter((note) => note.text === 'Switched to work')).toHaveLength(1);
    expect(model.notes[0]).toMatchObject({ turn: 0, offset: 3, seq: 6 });
  });

  it('is not a second copy of a notice the window already watched arrive', () => {
    const model = run([
      delta('abc'), worker({ type: 'note', message: 'Switched to work', seq: 6, responseOffset: 3 }),
      snapshot({ marks: [{ kind: 'notice', id: 'notice:6', seq: 6, responseOffset: 3, message: 'Switched to work' }] }),
    ], begin());
    expect(model.notes).toHaveLength(1);
  });

  it('takes the worker\'s duration for a thought the window also held, keeping its longer text', () => {
    const model = run([
      activity({ kind: 'thinking', id: 'r1', label: 'looking at it and then some more words', seq: 3 }),
      activity({ kind: 'tool-start', id: 't', label: 'Read a.ts', category: 'read', seq: 4 }),
      snapshot({ marks: [thoughtMark] }),
    ], begin());
    expect(model.live!.reasoning).toHaveLength(1);
    expect(model.live!.reasoning[0]).toMatchObject({ ms: 4_200, heading: 'Reading the parser', text: 'looking at it and then some more words', seq: 3 });
  });

  it('keeps what the window held when the snapshot carries none of it', () => {
    const model = run([
      activity({ kind: 'thinking', id: 'r1', label: 'first thought', seq: 3 }),
      activity({ kind: 'tool-start', id: 't', label: 'Read a.ts', category: 'read', seq: 4 }),
      snapshot({}),
    ], begin());
    expect(model.live!.reasoning).toHaveLength(1);
  });

  it('shows the worker\'s phase only before any answer, and never an approval wait', () => {
    expect(joined({ text: '', phase: 'switching to claude-opus' }).live!.phase).toBe('switching to claude-opus');
    expect(joined({ phase: 'switching to claude-opus' }).live!.phase).toBeUndefined();
    expect(joined({ text: '', phase: 'waiting for your approval: make clean' }).live!.phase).toBeUndefined();
  });

  it('a phase event of an approval wait is not kept as the status', () => {
    const model = run([worker({ type: 'phase', message: 'waiting for your approval: make clean' })], begin());
    expect(model.live!.phase).toBeUndefined();
  });

  it('carries the usage so far', () => {
    const model = joined({ usage: { output: 840, input: 2_000 } });
    expect(model.turnUsage).toMatchObject({ output: 840 });
  });
});

describe('a reopened turn draws the worker\'s marks (X5)', () => {
  const marks = [
    { kind: 'thought', id: 'thought:r1', seq: 1, responseOffset: 0, durationMs: 3_400, heading: 'Reading the parser', text: 'let me look' },
    { kind: 'plan', id: 'plan', seq: 3, responseOffset: 5, entries: [{ content: 'one', status: 'completed' }] },
    { kind: 'notice', id: 'notice:4', seq: 4, responseOffset: 5, message: 'Switched to work' },
    { kind: 'outcome', id: 'outcome:ap1', seq: 5, responseOffset: 5, outcome: 'denied', label: 'make clean' },
  ];
  const saved = (patch: Record<string, unknown> = {}, activities = true): HarnessSession => session({
    messages: [{ role: 'user', content: 'go' }, {
      role: 'assistant', content: 'hello world', turnEnd: { ms: 20_000 }, marks,
      ...(activities ? { activities: [{ event: { kind: 'tool-done', id: 'a', label: 'Read a.ts', category: 'read', seq: 2 }, responseOffset: 0 }] } : {}),
      ...patch,
    } as never],
  });
  const reopened = (value: HarnessSession) => applyEvent(emptyModel(), { type: 'session', session: value });

  it('keeps the settled thought with its heading and duration', () => {
    const trace = reopened(saved()).traces[0]!;
    expect(trace.reasoning).toEqual([{ text: 'let me look', heading: 'Reading the parser', offset: 0, ms: 3_400, seq: 1 }]);
  });

  it('keeps the plan once, at its offset, with every step done', () => {
    const trace = reopened(saved()).traces[0]!;
    expect(trace.plan).toEqual([{ content: 'one', status: 'completed' }]);
    expect(trace.planAt).toEqual({ offset: 5, seq: 3 });
  });

  it('keeps notices and decisions at their offsets', () => {
    const trace = reopened(saved()).traces[0]!;
    expect(trace.notices).toEqual([{ id: 'notice:4', text: 'Switched to work', offset: 5, seq: 4 }]);
    expect(trace.decisions).toEqual([{ id: 'outcome:ap1', offset: 5, seq: 5, decision: { kind: 'denied', label: 'make clean' } }]);
  });

  it('lays them out in (offset, seq) order with the saved calls', () => {
    const trace = reopened(saved()).traces[0]!;
    const rows = turnMarks('hello world', trace.activities, trace.reasoning ?? [], [], {
      ...(trace.plan ? { plan: trace.planAt! } : {}),
      notes: trace.notices!.map((notice) => ({ offset: notice.offset, seq: notice.seq, note: { kind: 'notice' as const, text: notice.text, after: 1 } })),
      decisions: trace.decisions!,
    });
    expect(rows.map((row) => (row.thought ? 'thought' : row.activity ? 'call' : row.plan ? 'plan' : row.note ? 'notice' : 'decision')))
      .toEqual(['thought', 'call', 'plan', 'notice', 'decision']);
  });

  it('a turn saved before marks renders as it did', () => {
    const trace = reopened(session({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok', turnEnd: { ms: 20_000 },
      activities: [{ event: { kind: 'tool-done', id: 'a', label: 'Read a.ts', category: 'read' }, responseOffset: 0 }] } as never] })).traces[0]!;
    expect(trace.reasoning).toBeUndefined();
    expect(trace.plan).toBeUndefined();
    expect(trace.notices).toBeUndefined();
    expect(trace.decisions).toBeUndefined();
  });

  it('a turn with marks and no calls still has a trace to draw them from', () => {
    expect(reopened(saved({}, false)).traces).toHaveLength(1);
  });

  it('a notice the window watched is not drawn a second time', () => {
    const watched = { kind: 'notice' as const, text: 'Switched to work', after: 1, turn: 0, offset: 5, seq: 4 };
    const trace = reopened(saved()).traces[0]!;
    expect(turnNoticeNotes([watched], trace)).toHaveLength(1);
    expect(turnNoticeNotes(undefined, trace)).toHaveLength(1);
  });
});

describe('the thought row (X5)', () => {
  it('says how long, and the heading when the model wrote one', () => {
    expect(thoughtRow({ durationMs: 3_400 })).toBe('Thought for 3s');
    expect(thoughtRow({ durationMs: 120 })).toBe('Thought for 1s');
    expect(thoughtRow({ durationMs: 3_400, heading: 'Reading the parser' })).toBe('Thought for 3s · Reading the parser');
  });
});

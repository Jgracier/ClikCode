/** The turn-flow standard, second wave: what the worker now sends (seq, marks,
 * thought, phase, usage) wired into the extension's model and page logic. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exploreRuns } from '../../../../src/harness/protocol/turn-flow';
import { thoughtRow } from '../../../../src/harness/protocol/turn-flow';
import { answeredApproval, applyEvent, emptyModel, liveChildren, turnMarks, turnNoticeNotes, type ChatModel } from '../../src/model';
import { activityOutcome } from '../../../../src/harness/protocol/activity-view';
import { decisionBadge, liveMeter, shimmerStyle, traceSummaryLine, workingDetail, workingIndicator, workingStatus } from '../../src/webview/flow';
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

describe('an approval decision settles where it was asked (X8)', () => {
  const asked = (extra: Record<string, unknown> = {}): ChatModel => run([
    delta('abc'),
    worker({ type: 'approval-request', id: 'ap1', title: 'make clean', seq: 9, responseOffset: 3, ...extra }),
  ], begin());

  it('is one settled row at the place the request was asked', () => {
    const model = applyEvent(asked(), worker({ type: 'request-closed', id: 'ap1', outcome: 'approved', label: 'make clean' }));
    expect(model.approvals).toEqual([]);
    expect(model.live!.decisions).toEqual([{ id: 'outcome:ap1', offset: 3, seq: 9, decision: { kind: 'approved', label: 'make clean' } }]);
  });

  it('a request withdrawn without a decision leaves no row', () => {
    const model = applyEvent(asked(), worker({ type: 'request-closed', id: 'ap1' }));
    expect(model.live!.decisions ?? []).toEqual([]);
  });

  it('answered here, it is drawn at once and the worker\'s outcome is the same row', () => {
    let model = answeredApproval(asked(), 'ap1', { outcome: 'approved', always: true });
    expect(model.live!.decisions).toEqual([{ id: 'outcome:ap1', offset: 3, seq: 9, decision: { kind: 'approved', label: 'make clean', always: true } }]);
    model = applyEvent(model, worker({ type: 'request-closed', id: 'ap1', outcome: 'approved', label: 'make clean' }));
    expect(model.live!.decisions).toHaveLength(1);
    expect(model.live!.decisions![0]!.decision).toMatchObject({ kind: 'approved', always: true });
  });

  it('denied with a note says what it was told', () => {
    const model = answeredApproval(asked(), 'ap1', { outcome: 'denied', told: 'use pnpm instead' });
    expect(model.live!.decisions![0]!.decision).toEqual({ kind: 'told', text: 'use pnpm instead' });
    const closed = applyEvent(model, worker({ type: 'request-closed', id: 'ap1', outcome: 'denied', label: 'make clean' }));
    expect(closed.live!.decisions![0]!.decision).toEqual({ kind: 'told', text: 'use pnpm instead' });
  });

  it('is not duplicated by the snapshot\'s outcome mark', () => {
    const closed = applyEvent(asked(), worker({ type: 'request-closed', id: 'ap1', outcome: 'denied', label: 'make clean' }));
    const model = applyEvent(closed, worker({ type: 'snapshot', session: session(), live: { text: 'abc', waitingLabel: 'thinking',
      marks: [{ kind: 'outcome', id: 'outcome:ap1', seq: 9, responseOffset: 3, outcome: 'denied', label: 'make clean' }] } }));
    expect(model.live!.decisions).toHaveLength(1);
  });

  it('settles the call row of the same call id, instead of a second row', () => {
    const model = run([
      activity({ kind: 'tool-start', id: 'call-1', label: '$ make clean', category: 'run', seq: 8 }),
      worker({ type: 'approval-request', id: 'ap1', title: 'make clean', callId: 'call-1', seq: 9, responseOffset: 0 }),
      worker({ type: 'request-closed', id: 'ap1', outcome: 'denied', label: 'make clean' }),
    ], begin());
    const rows = turnMarks(model.live!.text, model.live!.activities, model.live!.reasoning, model.live!.steers, { decisions: model.live!.decisions! });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.activity!.decision).toEqual({ kind: 'denied', label: 'make clean' });
  });

  it('a decision from the worker names the call, so a window that never saw the request still settles the call row', () => {
    const model = run([
      activity({ kind: 'tool-start', id: 'call-1', label: '$ make clean', category: 'run', seq: 8 }),
      worker({ type: 'request-closed', id: 'ap1', outcome: 'denied', label: 'make clean', callId: 'call-1' }),
    ], begin());
    const rows = turnMarks(model.live!.text, model.live!.activities, model.live!.reasoning, model.live!.steers, { decisions: model.live!.decisions! });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.activity!.decision).toEqual({ kind: 'denied', label: 'make clean' });
  });

  it('a saved outcome mark with a call id settles the call row on reopen', () => {
    const value = session({ messages: [{ role: 'user', content: 'go' }, {
      role: 'assistant', content: 'ok', turnEnd: { ms: 20_000 },
      activities: [{ event: { kind: 'tool-error', id: 'call-1', label: '$ make clean', category: 'run', seq: 1 }, responseOffset: 0 }],
      marks: [{ kind: 'outcome', id: 'outcome:ap1', seq: 2, responseOffset: 0, outcome: 'denied', label: 'make clean', callId: 'call-1' }],
    } as never] });
    const trace = applyEvent(emptyModel(), { type: 'session', session: value }).traces[0]!;
    const rows = turnMarks('ok', trace.activities, [], [], { decisions: trace.decisions! });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.activity!.decision).toEqual({ kind: 'denied', label: 'make clean' });
  });

  it('is a row of its own where the vendor reports no call', () => {
    const model = applyEvent(asked(), worker({ type: 'request-closed', id: 'ap1', outcome: 'denied', label: 'make clean' }));
    const rows = turnMarks(model.live!.text, model.live!.activities, [], [], { decisions: model.live!.decisions! });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision!.decision).toEqual({ kind: 'denied', label: 'make clean' });
  });

  it('goes with the turn into its trace', () => {
    const model = run([worker({ type: 'request-closed', id: 'ap1', outcome: 'approved', label: 'make clean' }), worker({ type: 'waiting-stop' })], asked());
    expect(model.traces[0]!.decisions).toHaveLength(1);
  });
});

describe('spinners on one clock (X7)', () => {
  it('the shimmer moves a cell a step on the terminal\'s cadence', () => {
    // 10 characters + a band either side, one cell per 100 ms step.
    expect(shimmerStyle('Reading it')).toBe('--shimmer-cycle: 1800ms; --shimmer-steps: 18');
  });

  it('a decision on a call row names the decision, not the call again', () => {
    expect(decisionBadge({ kind: 'approved', label: 'make clean' })).toEqual({ text: '✓ approved', tone: 'ok' });
    expect(decisionBadge({ kind: 'denied', label: 'make clean' })).toEqual({ text: '✗ denied', tone: 'no' });
    expect(decisionBadge({ kind: 'told', text: 'use pnpm' })).toEqual({ text: '↳ told: use pnpm', tone: 'told' });
  });
});

describe('the token meter and the summary (X2)', () => {
  it('estimates from the response until the vendor reports, and shows nothing at zero', () => {
    expect(liveMeter({ shown: 0, responseChars: 0 })).toEqual({ tokens: 0 });
    const first = liveMeter({ shown: 0, responseChars: 4_000 });
    // A fifth of the gap to 1000, at least one.
    expect(first).toEqual({ tokens: 200, label: '↓ 200 tokens' });
  });

  it('steps toward the vendor\'s reported output and never falls', () => {
    let shown = 0;
    for (let step = 0; step < 60; step += 1) shown = liveMeter({ shown, usage: { output: 1_200 }, responseChars: 40 }).tokens;
    expect(shown).toBe(1_200);
    expect(liveMeter({ shown, usage: { output: 900 }, responseChars: 40 }).tokens).toBe(1_200);
    expect(liveMeter({ shown, usage: { output: 1_200 }, responseChars: 40 }).label).toBe('↓ 1.2k tokens');
  });

  it('the working line reads the clock then the meter, as the terminal\'s does', () => {
    expect(workingDetail(62_000, '↓ 1.2k tokens')).toBe('1m 2s · ↓ 1.2k tokens');
    expect(workingDetail(4_000, undefined)).toBe('4s');
  });

  it('a finished turn\'s line carries what it spent, live and on reopen', () => {
    const trace = { startedAt: 0, endedAt: 62_000, activities: [{ key: 'a', kind: 'tool-done' as const, label: 'x' }], usage: { input: 18, output: 164, costUsd: 0.0237 } };
    // A small, cheap turn leaves its spend to /usage; a large or costly one carries it.
    expect(traceSummaryLine(trace, [])).toBe('Worked for 1m 2s');
    expect(traceSummaryLine({ ...trace, usage: { input: 21_000, output: 164, costUsd: 0.0237 } }, [])).toBe('Worked for 1m 2s · ↑ 21k ↓ 164 tokens · $0.02');
  });

  it('says it is waiting on background agents instead of "Worked for"', () => {
    const trace = { startedAt: 0, endedAt: 62_000, activities: [{ key: 'a', kind: 'tool-done' as const, label: 'x' }], pendingBackground: 2 };
    expect(traceSummaryLine(trace, [])).toBe('Waiting for 2 background agents');
  });

  it('a turn ending keeps the usage it reported in its trace', () => {
    const model = run([
      activity({ kind: 'tool-start', id: 't', label: 'Read a.ts', category: 'read' }),
      worker({ type: 'usage', usage: { input: 10, output: 20 } }),
      worker({ type: 'waiting-stop' }),
    ], begin());
    expect(model.traces[0]!.usage).toMatchObject({ output: 20 });
  });

  it('reopened, the saved turn\'s usage and background count reach the trace', () => {
    const opened = applyEvent(emptyModel(), { type: 'session', session: session({
      messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok', turnEnd: { ms: 62_000, usage: { output: 164 }, pendingBackground: 1 },
        activities: [{ event: { kind: 'tool-done', id: 'a', label: 'Read a.ts', category: 'read' }, responseOffset: 0 }] } as never],
    }) });
    expect(opened.traces[0]).toMatchObject({ usage: { output: 164 }, pendingBackground: 1 });
    expect(traceSummaryLine(opened.traces[0]!, [])).toBe('Waiting for 1 background agent');
  });
});

describe('sub-agents: children under their parent (X6)', () => {
  const agent = { kind: 'tool-start', id: 'a1', label: 'Agent explore', agent: true };
  const child = (id: string, kind: string, extra: Record<string, unknown> = {}) => activity({ kind, id, parentId: 'a1', label: `Read ${id}`, category: 'read', ...extra });
  const parentOf = (model: ChatModel) => model.live!.activities[0]!;

  it('nests each child under its parent in the order they began, and adds no top-level row', () => {
    const model = run([activity(agent), child('c1', 'tool-start'), child('c2', 'tool-start')], begin());
    expect(model.live!.activities).toHaveLength(1);
    expect(parentOf(model).children!.map((row) => [row.key, row.kind])).toEqual([['c1', 'tool-start'], ['c2', 'tool-start']]);
  });

  it('counts unique child call ids, however many frames one call sends', () => {
    const model = run([
      activity(agent),
      child('c1', 'tool-start'), child('c1', 'tool-start', { label: 'Read c1 with input' }), child('c1', 'tool-done'),
      child('c2', 'tool-done'),
    ], begin());
    expect(parentOf(model).children).toHaveLength(2);
    expect(parentOf(model).childTools).toBe(2);
  });

  it('one child finishing never clears another\'s live line', () => {
    const model = run([activity(agent), child('c1', 'tool-start'), child('c2', 'tool-start'), child('c1', 'tool-done')], begin());
    expect(liveChildren(parentOf(model)).map((row) => row.child.key)).toEqual(['c2']);
  });

  it('shows the last three running children', () => {
    const model = run([activity(agent), ...['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => child(id, 'tool-start'))], begin());
    const rows = liveChildren(parentOf(model));
    expect(rows.map((row) => row.child.key)).toEqual(['c3', 'c4', 'c5']);
    expect(rows.map((row) => row.newest)).toEqual([false, false, true]);
  });

  it('a child that began after answer text sits below it, at its own place', () => {
    const model = run([activity(agent), child('c1', 'tool-start'), delta('and then some text'), child('c2', 'tool-start')], begin());
    const rows = liveChildren(parentOf(model));
    expect(rows.map((row) => [row.child.key, row.beside])).toEqual([['c1', true], ['c2', false]]);
    const marks = turnMarks(model.live!.text, model.live!.activities, [], []);
    expect(marks.map((mark) => mark.activity?.key ?? mark.child?.child.key)).toEqual(['a1', 'c2']);
    expect(marks[1]!.offset).toBe(18);
  });

  it('the settled row says what the harness reported, else what was counted', () => {
    const counted = run([activity(agent), child('c1', 'tool-start'), child('c2', 'tool-start'), activity({ ...agent, kind: 'tool-done' })], begin());
    expect(activityOutcome(parentOf(counted))?.parts).toEqual(['2 tool uses']);
    const reported = run([activity(agent), child('c1', 'tool-start'),
      activity({ ...agent, kind: 'tool-done', childTools: 7, childTokens: 12_000, durationMs: 5_000 })], begin());
    expect(activityOutcome(parentOf(reported))?.parts).toEqual(['7 tool uses', '12k tokens', '5.0s']);
  });

  it('the children stay on the settled row, with nothing left running', () => {
    const model = run([activity(agent), child('c1', 'tool-start'), activity({ ...agent, kind: 'tool-done' }), worker({ type: 'waiting-stop' })], begin());
    expect(model.traces[0]!.activities[0]!.children!.map((row) => row.kind)).toEqual(['tool-done']);
  });

  it('a reopened turn nests them too', () => {
    const opened = applyEvent(emptyModel(), { type: 'session', session: session({
      messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok', activities: [
        { event: { kind: 'tool-done', id: 'a1', label: 'Agent explore', agent: true, childTools: 2 }, responseOffset: 0 },
        { event: { kind: 'tool-done', id: 'c1', parentId: 'a1', label: 'Read c1', category: 'read' }, responseOffset: 0 },
        { event: { kind: 'tool-done', id: 'c2', parentId: 'a1', label: 'Read c2', category: 'read' }, responseOffset: 0 },
      ] } as never],
    }) });
    const [row, ...rest] = opened.traces[0]!.activities;
    expect(rest).toEqual([]);
    expect(row!.children!.map((entry) => entry.key)).toEqual(['c1', 'c2']);
    expect(row!.childTools).toBe(2);
  });

  it('reading the same saved turn again changes nothing (no clock on a saved child)', () => {
    const saved = session({
      messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok', activities: [
        { event: { kind: 'tool-done', id: 'a1', label: 'Agent explore', agent: true }, responseOffset: 0 },
        { event: { kind: 'tool-done', id: 'c1', parentId: 'a1', label: 'Read c1', category: 'read' }, responseOffset: 0 },
      ] } as never],
    });
    const first = applyEvent(emptyModel(), { type: 'session', session: saved });
    const again = applyEvent(first, { type: 'session', session: saved });
    expect(again.traces).toBe(first.traces);
  });

  it('a child whose parent was never seen is a row of its own, not dropped', () => {
    const model = run([child('c9', 'tool-start')], begin());
    expect(model.live!.activities.map((row) => row.key)).toEqual(['c9']);
  });
});

describe('adjacent read, search and list calls are one group (X9)', () => {
  it('the page groups them with the same function the terminal does', () => {
    const rows = [
      { key: 'a', kind: 'tool-done' as const, label: 'Read a.ts', category: 'read' as const },
      { key: 'b', kind: 'tool-done' as const, label: 'List src', category: 'search' as const },
      { key: 'c', kind: 'tool-start' as const, label: 'Grep foo', category: 'search' as const },
      { key: 'd', kind: 'tool-start' as const, label: '$ ls', category: 'run' as const },
    ];
    expect(exploreRuns(rows).map((group) => [group.explore, group.rows.map((row) => row.key)])).toEqual([[true, ['a', 'b', 'c']], [false, ['d']]]);
  });
});

describe('background work by kind: workflows on the end line, terminals on the working line (standard 10)', () => {
  it('a workflow count rides the event into the trace and the end line says it in Claude Code\'s words', () => {
    const model = run([
      delta('Started them.'),
      worker({ type: 'background', pending: 2, work: { agents: 2, workflows: 1, terminals: 3 } }),
      worker({ type: 'waiting-stop' }),
    ], begin());
    const trace = model.traces[0]!;
    expect(trace).toMatchObject({ pendingBackground: 2, pendingWorkflows: 1 });
    // A terminal is never part of the end line.
    expect(traceSummaryLine({ ...trace, endedAt: 5_000, startedAt: 0 }, [])).toBe('Waiting for 2 background agents and 1 dynamic workflow');
  });

  it('terminals alone leave no end-line wait and no trace of their own', () => {
    const model = run([delta('x'), worker({ type: 'background', pending: 0, work: { terminals: 2 } }), worker({ type: 'waiting-stop' })], begin());
    expect(model.traces[0]?.pendingBackground).toBeUndefined();
    expect(model.traces[0]?.pendingWorkflows).toBeUndefined();
  });

  it('the fixed work section carries the terminals indicator while any run', () => {
    const live = (work: Record<string, number> | undefined) => run([worker({ type: 'background', pending: 0, ...(work ? { work } : {}) })], begin()).live!;
    expect(workingIndicator(live({ terminals: 1 }))).toBe('1 background terminal running');
    expect(workingIndicator(live({ terminals: 3 }))).toBe('3 background terminals running');
    expect(workingIndicator(live(undefined))).toBeUndefined();
    expect(workingIndicator(undefined)).toBeUndefined();
  });

  it('a window joining mid-turn takes every kind from the snapshot, and the later event replaces it', () => {
    const joined = applyEvent(begin(), worker({ type: 'snapshot', session: session(), live: { text: 'abc', waitingLabel: 'thinking', pendingBackground: 1, background: { agents: 1, terminals: 2 } } }));
    expect(workingIndicator(joined.live)).toBe('2 background terminals running');
    const after = applyEvent(joined, worker({ type: 'background', pending: 1, work: { agents: 1 } }));
    expect(workingIndicator(after.live)).toBeUndefined();
    expect(after.live!.pendingBackground).toBe(1);
  });

  it('keeps background agent identities by the composer after the parent turn ends', () => {
    const work = { agents: 1, agentTasks: [{ id: 'a', label: 'Review auth' }] };
    const during = run([worker({ type: 'background', pending: 1, work })], begin());
    const ended = applyEvent(during, worker({ type: 'waiting-stop' }));
    expect(ended.running).toBe(false);
    expect(ended.live).toBeUndefined();
    expect(ended.background).toEqual(work);
    const joined = applyEvent(begin(), worker({ type: 'snapshot', session: session(), background: work }));
    expect(joined.background).toEqual(work);
  });

  it('a saved turn says its workflows on reopen', () => {
    const reopened = applyEvent(emptyModel(), { type: 'session', session: session({ messages: [{ role: 'user', content: 'go' }, {
      role: 'assistant', content: 'ok', turnEnd: { ms: 20_000, pendingBackground: 1, background: { agents: 1, workflows: 2 } } } as never] }) });
    expect(reopened.traces[0]).toMatchObject({ pendingBackground: 1, pendingWorkflows: 2 });
    expect(traceSummaryLine(reopened.traces[0]!, [])).toBe('Waiting for 1 background agent and 2 dynamic workflows');
  });
});

describe('background agents the vendor left running (standard 10)', () => {
  it('the worker\'s count is kept live and goes with the turn into its trace, so the end line says it', () => {
    const model = run([
      delta('Started them.'),
      worker({ type: 'background', pending: 2 }),
      worker({ type: 'waiting-stop' }),
    ], begin());
    const trace = model.traces[0]!;
    expect(trace.pendingBackground).toBe(2);
    expect(traceSummaryLine({ ...trace, endedAt: 5_000, startedAt: 0 }, [])).toBe('Waiting for 2 background agents');
  });

  it('a count that fell back to none says nothing', () => {
    const model = run([worker({ type: 'background', pending: 2 }), worker({ type: 'background', pending: 0 }), delta('x'), worker({ type: 'waiting-stop' })], begin());
    expect(model.traces[0]?.pendingBackground).toBeUndefined();
  });

  it('a window joining mid-turn takes the count from the snapshot', () => {
    const model = applyEvent(begin(), worker({ type: 'snapshot', session: session(), live: { text: 'abc', waitingLabel: 'thinking', pendingBackground: 1 } }));
    expect(model.live!.pendingBackground).toBe(1);
  });

  it('a saved turn says it on reopen', () => {
    const reopened = applyEvent(emptyModel(), { type: 'session', session: session({ messages: [{ role: 'user', content: 'go' }, {
      role: 'assistant', content: 'ok', turnEnd: { ms: 20_000, pendingBackground: 3 } } as never] }) });
    expect(reopened.traces[0]!.pendingBackground).toBe(3);
  });

  it('a snapshot\'s plan is placed where the worker says it began', () => {
    const model = applyEvent(emptyModel(), worker({ type: 'snapshot', session: session(), live: {
      text: 'Before. After.', waitingLabel: 'thinking', plan: [{ content: 'one', status: 'in_progress' }], planOffset: 8 } }));
    expect(model.live!.planAt).toMatchObject({ offset: 8 });
  });
});

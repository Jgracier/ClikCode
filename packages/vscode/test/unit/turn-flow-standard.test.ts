/** The turn-flow standard (docs/TURN_FLOW_STANDARD.md) as the extension's
 * model and page logic hold it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exploreRuns } from '../../../../src/harness/protocol/turn-flow';
import { applyEvent, connectionLost, emptyModel, preparing, reconnecting, rejectedPrompt, submittingPrompt, turnMarks, type ChatModel } from '../../src/model';
import { createStreamingMarkdown } from '../../src/webview/markdown';
import { followsBottom, runGroupView, traceSummaryLine, workingStatus } from '../../src/webview/flow';
import type { HarnessSession, IdeEvent } from '../../src/protocol';

const session = (patch: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'opencode', model: 'opencode/big-pickle', effort: 'medium',
  permissionMode: 'ask', createdAt: '', updatedAt: '', status: 'active', nativeHarness: 'opencode',
  messages: [], ...patch,
});
const worker = (event: unknown): IdeEvent => ({ type: 'worker', sessionId: 's1', event } as IdeEvent);
const activity = (event: Record<string, unknown>): IdeEvent => worker({ type: 'activity', event });
const run = (events: IdeEvent[], start: ChatModel = emptyModel()): ChatModel => events.reduce(applyEvent, start);
const begin = (): ChatModel => run([
  { type: 'ready', version: '1', pid: 1 }, { type: 'session', session: session() },
  { type: 'turn-start', sessionId: 's1', prompt: 'hi' }, worker({ type: 'waiting-start', message: 'thinking' }),
]);

afterEach(() => { vi.useRealTimers(); });

describe('a mid-turn snapshot (V1)', () => {
  it('keeps the thoughts and every running call\'s clock the window already holds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let model = run([
      activity({ kind: 'thinking', id: 'r1', label: '**Planning the edit** looking at the file' }),
      activity({ kind: 'tool-start', id: 't1', label: '$ npm test', category: 'run' }),
    ], begin());
    expect(model.live!.reasoning).toHaveLength(1);
    vi.setSystemTime(41_000);
    model = applyEvent(model, worker({
      type: 'snapshot', session: session({ pendingTurn: { prompt: 'hi', startedAt: new Date(1_000).toISOString() } as never }),
      live: { text: '', waitingLabel: 'thinking', activities: [{ event: { kind: 'tool-start', id: 't1', label: '$ npm test', category: 'run' }, responseOffset: 0 }] },
    }));
    expect(model.live!.reasoning).toHaveLength(1);
    expect(model.live!.activities[0]!.startedAt).toBe(1_000);
    expect(model.live!.activities).toHaveLength(1);
  });

  it('keeps the thought being had, and adds a call only the snapshot knew', () => {
    const model = run([
      activity({ kind: 'thinking', id: 'r1', label: 'weighing options' }),
      worker({ type: 'snapshot', session: session(), live: { text: 'ab', waitingLabel: 'thinking', activities: [{ event: { kind: 'tool-done', id: 'x', label: 'read a.ts', category: 'read' }, responseOffset: 1 }] } }),
    ], begin());
    expect(model.live!.thought?.text).toBe('weighing options');
    expect(model.live!.activities.map((item) => item.key)).toEqual(['x']);
    expect(model.live!.text).toBe('ab');
  });
});

describe('the sticky prompt (V2)', () => {
  it('is dropped once the durable record holds it', () => {
    const lost = connectionLost(begin());
    expect(lost.running).toBe(false);
    expect(lost.pendingPrompt).toBeUndefined();
    expect(lost.ownTurn).toBeUndefined();
    const sent = submittingPrompt(run([{ type: 'session', session: session() }]), 'hi');
    const after = applyEvent(sent, { type: 'session', session: session({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }] }) });
    expect(after.pendingPrompt).toBeUndefined();
  });

  it('still shows while the worker has not written it yet', () => {
    const sent = submittingPrompt(run([{ type: 'session', session: session({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }] }) }]), 'hi again');
    expect(applyEvent(sent, { type: 'session', session: session({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }] }) }).pendingPrompt).toBe('hi again');
  });
});

describe('a reopened turn says what the live one said (V3)', () => {
  const saved = (turnEnd?: { ms: number; stopped?: true }, activities = true): HarnessSession => session({
    messages: [{ role: 'user', content: 'go' }, {
      role: 'assistant', content: 'done', ...(turnEnd ? { turnEnd } : {}),
      ...(activities ? { activities: [{ event: { kind: 'tool-done', id: 'a', label: 'read a.ts', category: 'read' }, responseOffset: 0 }] } : {}),
    } as never],
  });

  it('takes the duration from the saved turnEnd', () => {
    const trace = applyEvent(emptyModel(), { type: 'session', session: saved({ ms: 62_000 }) }).traces[0]!;
    expect(trace.endedAt - trace.startedAt).toBe(62_000);
    expect(traceSummaryLine(trace, [])).toBe('Worked for 1m 2s');
  });

  it('says Stopped after for a stopped one', () => {
    const trace = applyEvent(emptyModel(), { type: 'session', session: saved({ ms: 3_000, stopped: true }) }).traces[0]!;
    expect(trace.stopped).toBe(true);
    expect(traceSummaryLine(trace, [])).toBe('Stopped after 3s');
  });

  it('invents no duration when none was saved', () => {
    const trace = applyEvent(emptyModel(), { type: 'session', session: saved() }).traces[0]!;
    expect(traceSummaryLine(trace, [])).toBeUndefined();
  });

  it('keeps a turn with no calls that ran long enough to be summarised', () => {
    const model = applyEvent(emptyModel(), { type: 'session', session: saved({ ms: 90_000 }, false) });
    expect(model.traces).toHaveLength(1);
    expect(traceSummaryLine(model.traces[0]!, [])).toBe('Worked for 1m 30s');
  });
});

describe('a stop from another window (V4)', () => {
  const running = (): ChatModel => run([
    activity({ kind: 'tool-start', id: 't1', label: '$ sleep 60', category: 'run' }),
    worker({ type: 'delta', text: 'working', mode: 'append' }),
  ], begin());

  it('waiting-stop with stopped ends the turn as stopped, its open call closed as stopped', () => {
    const ended = applyEvent(running(), worker({ type: 'waiting-stop', stopped: true }));
    expect(ended.running).toBe(false);
    expect(ended.traces[0]).toMatchObject({ stopped: true });
    expect(ended.traces[0]!.activities[0]).toMatchObject({ id: 't1', stopped: true });
  });

  it('a snapshot with stopped and no live does the same', () => {
    const ended = applyEvent(running(), worker({ type: 'snapshot', session: session(), stopped: true }));
    expect(ended.running).toBe(false);
    expect(ended.traces[0]).toMatchObject({ stopped: true });
    expect(ended.traces[0]!.activities[0]).toMatchObject({ stopped: true });
  });

  it('a finished turn is not marked stopped', () => {
    const ended = applyEvent(running(), worker({ type: 'waiting-stop' }));
    expect(ended.traces[0]!.stopped).toBeUndefined();
  });
});

describe('one plan row, where it first appeared (V5)', () => {
  it('records the offset and order of the first plan and keeps it through updates', () => {
    vi.useFakeTimers();
    const model = run([
      worker({ type: 'delta', text: 'abc', mode: 'append' }),
      worker({ type: 'plan', entries: [{ content: 'one', status: 'in_progress' }] }),
      worker({ type: 'delta', text: 'defg', mode: 'append' }),
      worker({ type: 'plan', entries: [{ content: 'one', status: 'completed' }] }),
    ], begin());
    expect(model.live!.planAt).toMatchObject({ offset: 3 });
    expect(model.plan[0]!.status).toBe('completed');
  });

  it('ends in the trace at the same place, and the plan is not a second copy', () => {
    const model = run([
      worker({ type: 'delta', text: 'abc', mode: 'append' }),
      worker({ type: 'plan', entries: [{ content: 'one', status: 'pending' }] }),
      worker({ type: 'waiting-stop' }),
    ], begin());
    expect(model.traces[0]!.planAt).toMatchObject({ offset: 3 });
    expect(model.plan).toEqual([]);
  });

  it('is a mark in the turn between the rows around it', () => {
    const marks = turnMarks('abcdef', [{ key: 'a', kind: 'tool-done', label: 'x', offset: 3, seq: 1 }, { key: 'b', kind: 'tool-done', label: 'y', offset: 3, seq: 3 }], [], [],
      { plan: { offset: 3, seq: 2 } });
    expect(marks.map((mark) => (mark.activity ? mark.activity.key : 'plan'))).toEqual(['a', 'plan', 'b']);
  });
});

describe('steers sort by acknowledgement (V10)', () => {
  it('a steer goes between the rows that began before and after it', () => {
    const marks = turnMarks('abcdef', [{ key: 'a', kind: 'tool-done', label: 'x', offset: 3, seq: 1 }, { key: 'b', kind: 'tool-start', label: 'y', offset: 3, seq: 5 }], [],
      [{ text: 'steer', offset: 3, seq: 3 }]);
    expect(marks.map((mark) => mark.activity?.key ?? 'steer')).toEqual(['a', 'steer', 'b']);
  });

  it('a steer first seen in a snapshot takes the order it arrived in, and keeps it', () => {
    const live = (steers: Array<{ text: string; responseOffset: number }>) => worker({
      type: 'snapshot', session: session({ pendingTurn: { prompt: 'hi', startedAt: '', steers } as never }), live: { text: 'abc', waitingLabel: 'thinking' },
    });
    let model = run([live([{ text: 'one', responseOffset: 1 }])], begin());
    const first = model.live!.steers[0]!.seq;
    expect(first).toEqual(expect.any(Number));
    model = run([activity({ kind: 'tool-start', id: 'z', label: 'read', category: 'read' }), live([{ text: 'one', responseOffset: 1 }, { text: 'two', responseOffset: 2 }])], model);
    expect(model.live!.steers[0]!.seq).toBe(first);
    expect(model.live!.steers[1]!.seq!).toBeGreaterThan(model.live!.activities[0]!.seq!);
  });
});

describe('a notice stays where it arrived (V9)', () => {
  it('is anchored to the response offset of the running turn and keeps its turn at the end', () => {
    const model = run([
      worker({ type: 'delta', text: 'abc', mode: 'append' }),
      worker({ type: 'notice', message: 'Switched to work' }),
      worker({ type: 'delta', text: 'def', mode: 'append' }),
    ], begin());
    expect(model.notes[0]).toMatchObject({ turn: 0, offset: 3, text: 'Switched to work' });
    const ended = applyEvent(model, worker({ type: 'waiting-stop' }));
    expect(ended.notes[0]).toMatchObject({ turn: 0, offset: 3 });
    expect(ended.traces.find((trace) => trace.userIndex === 0)).toBeTruthy();
  });

  it('is a mark in the turn at its offset', () => {
    const marks = turnMarks('abcdef', [{ key: 'a', kind: 'tool-done', label: 'x', offset: 3, seq: 1 }], [], [],
      { notes: [{ offset: 3, seq: 2, note: { kind: 'notice', text: 'n', after: 1 } }] });
    expect(marks.map((mark) => mark.activity?.key ?? 'note')).toEqual(['a', 'note']);
  });

  it('a note outside a turn is not tied to one', () => {
    const model = applyEvent(run([{ type: 'session', session: session() }]), worker({ type: 'notice', message: 'hello' }));
    expect(model.notes[0]!.turn).toBeUndefined();
  });

  it('is rebased with the rows when the answer text is replaced', () => {
    const model = run([
      worker({ type: 'delta', text: 'abcdef', mode: 'append' }),
      worker({ type: 'notice', message: 'n' }),
      worker({ type: 'delta', text: 'abXY', mode: 'replace' }),
    ], begin());
    expect(model.notes[0]!.offset).toBe(2);
  });
});

describe('the prepare window (V11)', () => {
  const opened = (): ChatModel => run([{ type: 'ready', version: '1', pid: 1 }, { type: 'session', session: session() }]);

  it('is a pending prompt with no turn yet: Stop is available', () => {
    expect(preparing(opened())).toBe(false);
    const sent = submittingPrompt(opened(), 'first');
    expect(preparing(sent)).toBe(true);
    expect(preparing(applyEvent(sent, worker({ type: 'waiting-start', message: 'thinking' })))).toBe(false);
    expect(preparing(rejectedPrompt(sent))).toBe(false);
  });

  it('a second send does not overwrite the first bubble', () => {
    const sent = submittingPrompt(submittingPrompt(opened(), 'first'), 'second');
    expect(sent.pendingPrompt).toBe('first');
  });
});

describe('stable keys across merge points (V7)', () => {
  const read = (key: string) => ({ key, kind: 'tool-done' as const, label: `Read ${key}`, category: 'read' as const });

  it('a lone read and the group it grows into are the same row', () => {
    const lone = runGroupView(exploreRuns([read('a')]));
    const grown = runGroupView(exploreRuns([read('a'), read('b')]));
    expect(lone).toHaveLength(1);
    expect(grown).toHaveLength(1);
    expect(grown[0]!.key).toBe(lone[0]!.key);
    expect(grown[0]!.kind).toBe(lone[0]!.kind);
  });

  it('a command stays a call row', () => {
    const view = runGroupView(exploreRuns([{ key: 'c', kind: 'tool-start' as const, label: '$ ls', category: 'run' as const }]));
    expect(view[0]).toMatchObject({ key: 'c', kind: 'call' });
  });

  it('live markdown keeps earlier settled blocks as the same strings while it grows', () => {
    const render = createStreamingMarkdown();
    const one = render('first paragraph\n\nsecond paragraph\n\nthird');
    const two = render('first paragraph\n\nsecond paragraph\n\nthird paragraph\n\nfourth');
    expect(one.parts.length).toBeGreaterThan(0);
    expect(two.parts.length).toBeGreaterThan(one.parts.length);
    one.parts.forEach((part, index) => expect(two.parts[index]).toBe(part));
    expect(two.parts.join('')).toBe(two.stable);
  });
});

describe('nothing animates while the bridge reconnects (V8)', () => {
  it('a running turn on a bridge that is not ready is reconnecting', () => {
    const live = begin();
    expect(reconnecting(live)).toBe(false);
    expect(reconnecting({ ...live, connection: 'starting' })).toBe(true);
    expect(reconnecting({ ...emptyModel(), connection: 'starting' })).toBe(false);
  });

  it('the working line says so instead of a verb', () => {
    const live = begin().live!;
    expect(workingStatus(live, false, Date.now(), true).label).toBe('Reconnecting…');
    expect(workingStatus(live, false, Date.now()).label).not.toBe('Reconnecting…');
  });
});

describe('following the bottom of the log (V6)', () => {
  const at = (top: number, height: number, client = 500) => ({ top, height, client });
  const start = { follow: true, top: 0, height: 0 };

  it('stays on while the content grows under a reader at the bottom', () => {
    let state = followsBottom(start, at(500, 1000));
    expect(state.follow).toBe(true);
    state = followsBottom(state, at(900, 1400));
    expect(state.follow).toBe(true);
  });

  it('a small scroll up while streaming is not snapped back', () => {
    const state = followsBottom({ follow: true, top: 500, height: 1000 }, at(470, 1000));
    expect(state.follow).toBe(false);
  });

  it('scrolling back to the bottom follows again', () => {
    const state = followsBottom({ follow: false, top: 300, height: 1000 }, at(430, 1000));
    expect(state.follow).toBe(true);
  });

  it('a log that got shorter (the turn folded) is not the reader scrolling up', () => {
    const state = followsBottom({ follow: true, top: 900, height: 1400 }, at(600, 1100));
    expect(state.follow).toBe(true);
  });
});

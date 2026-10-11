/** The turn-flow standard (docs/TURN_FLOW_STANDARD.md) as the extension's
 * model and page logic hold it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, connectionLost, emptyModel, submittingPrompt, type ChatModel } from '../../src/model';
import { traceSummaryLine } from '../../src/webview/flow';
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

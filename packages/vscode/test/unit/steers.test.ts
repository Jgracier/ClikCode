import { describe, expect, it } from 'vitest';
import { applyEvent, emptyModel, typedDuringTurn, type ChatModel } from '../../src/model';
import { turnMarks } from '../../src/model/marks';
import type { HarnessSession, IdeEvent } from '../../src/protocol';

const session = (patch: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'opencode', model: 'm', effort: 'medium',
  permissionMode: 'ask', createdAt: '', updatedAt: '', status: 'active', nativeHarness: 'opencode',
  messages: [], ...patch,
});
const worker = (event: unknown): IdeEvent => ({ type: 'worker', sessionId: 's1', event } as IdeEvent);
const running = (): ChatModel => [
  { type: 'session', session: session() } as IdeEvent,
  worker({ type: 'waiting-start', message: 'thinking' }),
  worker({ type: 'delta', text: 'working on it', mode: 'append' }),
].reduce(applyEvent, emptyModel());
const pending = (steers: Array<{ id?: string; text: string }>) => ({
  prompt: 'go', startedAt: '2026-01-01T00:00:00Z', updatedAt: '', outputStarted: true,
  steers: steers.map((steer) => ({ ...steer, submittedAt: '' })),
}) as HarnessSession['pendingTurn'];

describe('steered and queued messages in the panel', () => {
  it('places a steer in the turn when it is acknowledged, by id, and takes it out of the queue', () => {
    let model = running();
    model = { ...model, queued: [{ id: 'a', text: 'yes', command: false }, { id: 'b', text: 'yes', command: false }] };
    model = typedDuringTurn(model, 'a', 'yes');
    model = applyEvent(model, worker({ type: 'submission', id: 'a', disposition: 'steered', seq: 5, responseOffset: 4 }));
    expect(model.live?.steers).toEqual([{ id: 'a', text: 'yes', offset: 4, seq: 5 }]);
    expect(model.queued.map((item) => item.id)).toEqual(['b']);
  });

  it('keeps a local steer across a snapshot read before it was persisted, and merges it by id once it was', () => {
    let model = typedDuringTurn(running(), 'a', 'yes');
    model = applyEvent(model, worker({ type: 'submission', id: 'a', disposition: 'steered', seq: 5, responseOffset: 4 }));
    const stale = applyEvent(model, worker({ type: 'snapshot', session: session({ pendingTurn: pending([]) }), live: { text: 'working on it', waitingLabel: 'thinking' } }));
    expect(stale.live?.steers.map((steer) => steer.id)).toEqual(['a']);
    const fresh = applyEvent(stale, worker({ type: 'snapshot', session: session({ pendingTurn: pending([{ id: 'a', text: 'yes' }]) }), live: { text: 'working on it', waitingLabel: 'thinking' } }));
    expect(fresh.live?.steers).toHaveLength(1);
    expect(fresh.live?.steers[0]).toMatchObject({ id: 'a', offset: 4, seq: 5 });
  });

  it('does not queue a message again from a snapshot that predates its steer', () => {
    let model = typedDuringTurn(running(), 'a', 'yes');
    model = applyEvent(model, worker({ type: 'submission', id: 'a', disposition: 'steered' }));
    const snap = applyEvent(model, worker({ type: 'snapshot', session: session({ pendingTurn: pending([]), queuedTurns: [{ id: 'a', text: 'yes', submittedAt: '' }] }), live: { text: 'working on it', waitingLabel: 'thinking' } }));
    expect(snap.queued).toEqual([]);
  });

  it('keeps a steered submission through the turn end until the saved messages arrive', () => {
    let model = typedDuringTurn(running(), 'a', 'yes');
    model = applyEvent(model, worker({ type: 'submission', id: 'a', disposition: 'steered' }));
    model = applyEvent(model, worker({ type: 'waiting-stop' }));
    expect(model.submissions.map((item) => item.id)).toEqual(['a']);
    const saved = applyEvent(model, { type: 'session', session: session() } as IdeEvent);
    expect(saved.submissions).toHaveLength(1);
    const done = applyEvent(model, worker({ type: 'snapshot', session: session({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'working' }, { role: 'user', content: 'yes' }, { role: 'assistant', content: 'ok' }] }) }));
    expect(done.submissions).toEqual([]);
  });

  it('draws nothing more of a turn once Stop was accepted', () => {
    let model = applyEvent(running(), worker({ type: 'stopping' }));
    const before = model.live?.text;
    model = applyEvent(model, worker({ type: 'delta', text: ' and more', mode: 'append' }));
    expect(model.live?.text).toBe(before);
  });

  it('keys two identical steers apart', () => {
    const marks = turnMarks('abc', [], [], [{ id: 'a', text: 'yes', offset: 1, seq: 1 }, { id: 'b', text: 'yes', offset: 1, seq: 2 }]);
    expect(marks.map((mark) => mark.steerId)).toEqual(['a', 'b']);
  });
});

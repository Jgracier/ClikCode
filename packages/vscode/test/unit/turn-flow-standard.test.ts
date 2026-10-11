/** The turn-flow standard (docs/TURN_FLOW_STANDARD.md) as the extension's
 * model and page logic hold it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyModel, type ChatModel } from '../../src/model';
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

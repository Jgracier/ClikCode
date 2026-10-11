/** The turn-flow standard, second wave: what the worker now sends (seq, marks,
 * thought, phase, usage) wired into the extension's model and page logic. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyModel, type ChatModel } from '../../src/model';
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

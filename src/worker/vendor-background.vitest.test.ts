import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTurnChannel } from '../harness/transport/background-turn.js';
import type { HarnessSession } from '../session/model.js';

const state = { sessions: [] as HarnessSession[] };
vi.mock('../session/state/read.js', () => ({ readState: async () => state }));
vi.mock('../session/state/write.js', () => ({ writeState: async () => undefined }));

const { backgroundTurnRecord, createVendorBackgroundRunner } = await import('./vendor-background.js');

function fakeObserver() {
  const frames: string[] = [];
  return {
    frames,
    startTurn: (label: string) => frames.push(`start ${label}`),
    stopWaiting: () => frames.push('stop'),
    response: (text: string) => frames.push(`delta ${text}`),
    activityEvent: (event: { kind: string; label: string }) => frames.push(`${event.kind} ${event.label}`),
    phase: () => undefined,
    setPlan: () => undefined,
    approval: async () => true,
    render: (session: HarnessSession) => frames.push(`render ${session.messages?.length ?? 0}`),
  };
}

describe('a worker running vendor background turns', () => {
  beforeEach(() => { state.sessions = [{ id: 's', messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'STARTED' }] } as HarnessSession]; });

  it('broadcasts one like a turn, keeps the worker busy, and persists what it did', async () => {
    const observer = fakeObserver();
    const changed = vi.fn();
    const runner = createVendorBackgroundRunner({ sessionId: 's', observer: observer as never, userTurnRunning: () => false, changed });
    const channel = new BackgroundTurnChannel('codex-app-server', 'background-work');
    runner.handle(channel);
    expect(runner.busy).toBe(true);
    channel.observer.onActivity?.({ kind: 'tool-done', label: 'sleep 30; echo BG', id: 'bg' });
    channel.finish('completed');
    await vi.waitFor(() => expect(runner.busy).toBe(false));
    expect(observer.frames).toEqual(['start background work', 'tool-done sleep 30; echo BG', 'render 3', 'stop']);
    expect(state.sessions[0]!.messages!.at(-1)).toEqual({ role: 'assistant', content: 'Background work finished: sleep 30; echo BG.' });
    expect(changed).toHaveBeenCalled();
  });

  it('waits for a user turn that is still finishing, and leaves a superseding turn\'s waiting line alone', async () => {
    const observer = fakeObserver();
    let userRunning = true;
    const runner = createVendorBackgroundRunner({ sessionId: 's', observer: observer as never, userTurnRunning: () => userRunning, changed: () => undefined });
    const channel = new BackgroundTurnChannel('acp', 'vendor-turn');
    channel.observer.onResponseDelta?.('The sub-agent finished.');
    runner.handle(channel);
    expect(observer.frames).toEqual([]);
    userRunning = false;
    runner.userTurnEnded();
    expect(observer.frames).toEqual(['start background work', 'delta The sub-agent finished.']);
    userRunning = true; // the next user turn started and superseded it
    channel.finish('superseded');
    await vi.waitFor(() => expect(runner.busy).toBe(false));
    expect(observer.frames).not.toContain('stop');
    expect(state.sessions[0]!.messages!.at(-1)).toEqual({ role: 'assistant', content: 'The sub-agent finished.' });
  });

  it('keeps nothing for a background turn that showed nothing', () => {
    expect(backgroundTurnRecord({ text: '  ', ended: 'completed' }, [])).toBeUndefined();
  });
});

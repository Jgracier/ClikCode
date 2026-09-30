import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTurnChannel } from '../harness/transport/background-turn.js';
import type { HarnessSession } from '../session/model.js';

const state = { sessions: [] as HarnessSession[] };
vi.mock('../session/state/read.js', () => ({ readState: async () => state }));
/** Set: a save waits for it -- a save still in flight. */
let writeGate: Promise<void> | undefined;
vi.mock('../session/state/write.js', () => ({ writeState: async () => { await writeGate; } }));

const { backgroundTurnRecord, createVendorBackgroundRunner } = await import('./vendor-background.js');

function fakeObserver() {
  const frames: string[] = [];
  let generation = 0;
  return {
    frames,
    get turnGeneration() { return generation; },
    startTurn: (label: string) => { generation++; frames.push(`start ${label}`); },
    stopWaiting: () => frames.push('stop'),
    response: (text: string) => frames.push(`delta ${text}`),
    activityEvent: (event: { kind: string; label: string }) => frames.push(`${event.kind} ${event.label}`),
    phase: () => undefined,
    setPlan: () => undefined,
    approval: async () => true,
    render: (session: HarnessSession) => frames.push(`render ${session.messages?.length ?? 0}`),
    endTurn(session?: HarnessSession) { if (session) this.render(session); this.stopWaiting(); },
  };
}

describe('a worker running vendor background turns', () => {
  beforeEach(() => { writeGate = undefined; state.sessions = [{ id: 's', messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'STARTED' }] } as HarnessSession]; });

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
    observer.startTurn('thinking');
    channel.finish('superseded');
    await vi.waitFor(() => expect(runner.busy).toBe(false));
    expect(observer.frames).not.toContain('stop');
    // Not saved beside the user turn, whose checkpoint rewrites the whole
    // transcript as it goes and would erase it...
    expect(state.sessions[0]!.messages).toHaveLength(2);
    // ...but once that turn's own save is done.
    userRunning = false;
    const saved = await runner.saveSuperseded();
    expect(saved?.messages?.at(-1)).toEqual({ role: 'assistant', content: 'The sub-agent finished.' });
    expect(state.sessions[0]!.messages!.at(-1)).toEqual({ role: 'assistant', content: 'The sub-agent finished.' });
  });

  it('saves a record superseded after the user turn\'s save when that turn ends', async () => {
    const observer = fakeObserver();
    let userRunning = false;
    const runner = createVendorBackgroundRunner({ sessionId: 's', observer: observer as never, userTurnRunning: () => userRunning, changed: () => undefined });
    const channel = new BackgroundTurnChannel('codex-app-server', 'vendor-turn');
    channel.observer.onResponseDelta?.('Late news.');
    runner.handle(channel);
    userRunning = true;
    observer.startTurn('thinking');
    expect(await runner.saveSuperseded()).toBeUndefined(); // the user turn's finally: nothing yet
    channel.finish('superseded');
    await vi.waitFor(() => expect(runner.busy).toBe(false));
    userRunning = false;
    runner.userTurnEnded();
    await runner.settled();
    expect(state.sessions[0]!.messages!.at(-1)).toEqual({ role: 'assistant', content: 'Late news.' });
  });

  it('has a user turn wait for a background record being saved', async () => {
    const observer = fakeObserver();
    let release!: () => void;
    writeGate = new Promise((resolve) => { release = resolve; });
    const runner = createVendorBackgroundRunner({ sessionId: 's', observer: observer as never, userTurnRunning: () => false, changed: () => undefined });
    const channel = new BackgroundTurnChannel('acp', 'vendor-turn');
    channel.observer.onResponseDelta?.('Done in the background.');
    runner.handle(channel);
    channel.finish('completed');
    let settled = false;
    await vi.waitFor(() => expect(state.sessions[0]!.messages).toHaveLength(3));
    void runner.settled().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it('does not end a turn that started while its record was being saved', async () => {
    const observer = fakeObserver();
    let userRunning = false;
    let release!: () => void;
    writeGate = new Promise((resolve) => { release = resolve; });
    const runner = createVendorBackgroundRunner({ sessionId: 's', observer: observer as never, userTurnRunning: () => userRunning, changed: () => undefined });
    const channel = new BackgroundTurnChannel('codex-app-server', 'background-work');
    channel.observer.onResponseDelta?.('Background result.');
    runner.handle(channel);
    channel.finish('completed');
    await vi.waitFor(() => expect(state.sessions[0]!.messages).toHaveLength(3));
    // While that save is in flight a user turn runs to its end, and the
    // window starts the next one from its queue.
    userRunning = true;
    observer.startTurn('thinking');
    userRunning = false;
    observer.stopWaiting();
    observer.startTurn('thinking');
    release();
    await vi.waitFor(() => expect(runner.busy).toBe(false));
    // The only stop is the user turn's own: the queued turn is left running.
    expect(observer.frames.filter((frame) => frame === 'stop')).toHaveLength(1);
    expect(observer.frames.at(-1)).toBe('start thinking');
  });

  it('keeps nothing for a background turn that showed nothing', () => {
    expect(backgroundTurnRecord({ text: '  ', ended: 'completed' }, [])).toBeUndefined();
  });
});

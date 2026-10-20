import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'node:net';
import type { WorkerEvent } from './protocol.js';

const recorded: unknown[] = [];
vi.mock('../turn/out-of-turn-record.js', () => ({ outOfTurnRecorder: () => async (said: unknown) => { recorded.push(said); } }));
const { createOutOfTurnRelay, isLimitRefusal } = await import('./out-of-turn.js');
const { BroadcastObserver } = await import('./broadcast-observer.js');

describe('a vendor speaking with no turn open', () => {
  const windows = (observer: InstanceType<typeof BroadcastObserver>): WorkerEvent[][] => {
    const seen: WorkerEvent[][] = [[], []];
    for (const events of seen) {
      observer.attach({ destroyed: false, writableLength: 0, write: (frame: string) => { events.push(JSON.parse(frame) as WorkerEvent); return true; } } as unknown as Socket);
    }
    return seen;
  };

  it('streams each chunk to every window as it comes, before anything is saved, and saves the message once', async () => {
    recorded.length = 0;
    const observer = new BroadcastObserver();
    const seen = windows(observer);
    const session = { id: 's1', messages: [{ role: 'assistant', content: 'The build finished.' }] };
    const ctx = { sessionId: 's1', observer, idle: { scheduleIdleExit: () => undefined }, io: { currentSessionAndAccount: async () => ({ session, account: 'work' }) } } as never;
    const { relay, settle } = createOutOfTurnRelay(ctx);
    relay({ kind: 'message', text: 'The build ', mode: 'append' });
    relay({ kind: 'message', text: 'finished.', mode: 'append' });
    // Shown at once, synchronously: nothing waits on the conversation being read or written.
    expect(recorded).toEqual([]);
    for (const events of seen) {
      expect(events.map((event) => event.type)).toEqual(['waiting-start', 'delta', 'delta']);
      expect(events.filter((event) => event.type === 'delta').map((event) => (event as { text: string }).text).join('')).toBe('The build finished.');
    }
    await settle();
    expect(recorded).toEqual([{ kind: 'message', text: 'The build finished.', mode: 'replace' }]);
    for (const events of seen) {
      expect(events.map((event) => event.type)).toContain('waiting-stop');
      expect(events.find((event) => event.type === 'snapshot')).toMatchObject({ session: { messages: [{ content: 'The build finished.' }] } });
    }
  });

  it('saves on its own once the vendor goes quiet', async () => {
    recorded.length = 0;
    const observer = new BroadcastObserver();
    const ctx = { sessionId: 's1', observer, idle: { scheduleIdleExit: () => undefined }, io: { currentSessionAndAccount: async () => ({ session: { id: 's1' }, account: 'work' }) } } as never;
    vi.useFakeTimers();
    try {
      createOutOfTurnRelay(ctx).relay({ kind: 'message', text: 'Done.', mode: 'append' });
      expect(recorded).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(recorded).toEqual([{ kind: 'message', text: 'Done.', mode: 'replace' }]);
    } finally { vi.useRealTimers(); }
  });
});

describe('a spent-limit sentence said with no turn open', () => {
  it('is told apart from ordinary speech', () => {
    expect(isLimitRefusal("You've hit your session limit · resets 11:40am (America/Denver)")).toBe(true);
    expect(isLimitRefusal('The build finished.')).toBe(false);
    expect(isLimitRefusal('I raised the rate limit in the config and the tests pass.')).toBe(false);
    expect(isLimitRefusal("You've hit your session limit.\nHere is the plan for the next step in detail.")).toBe(false);
  });
});

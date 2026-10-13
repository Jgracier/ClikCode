import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'node:net';
import type { WorkerEvent } from './protocol.js';

const recorded: unknown[] = [];
vi.mock('../turn/out-of-turn-record.js', () => ({ outOfTurnRecorder: () => async (said: unknown) => { recorded.push(said); } }));
const { createOutOfTurnRelay } = await import('./out-of-turn.js');
const { BroadcastObserver } = await import('./broadcast-observer.js');

describe('a vendor speaking with no turn open', () => {
  it('is recorded in the conversation and told live to every attached window', async () => {
    const observer = new BroadcastObserver();
    const seen: WorkerEvent[][] = [[], []];
    for (const events of seen) {
      observer.attach({ destroyed: false, writableLength: 0, write: (frame: string) => { events.push(JSON.parse(frame) as WorkerEvent); return true; } } as unknown as Socket);
    }
    const session = { id: 's1', messages: [{ role: 'assistant', content: 'The build finished.' }] };
    const ctx = { sessionId: 's1', observer, io: { currentSessionAndAccount: async () => ({ session, account: 'work' }) } } as never;
    createOutOfTurnRelay(ctx)({ kind: 'message', text: 'The build finished.', mode: 'append' });
    await vi.waitFor(() => expect(seen[1]!.some((event) => event.type === 'out-of-turn')).toBe(true));
    expect(recorded).toEqual([{ kind: 'message', text: 'The build finished.', mode: 'append' }]);
    for (const events of seen) {
      expect(events.map((event) => event.type)).toEqual(['snapshot', 'out-of-turn']);
      expect(events[0]).toMatchObject({ type: 'snapshot', session: { messages: [{ content: 'The build finished.' }] } });
      expect(events[0]).not.toHaveProperty('live');
      expect(events[1]).toEqual({ type: 'out-of-turn', kind: 'message', text: 'The build finished.', mode: 'append' });
    }
  });
});

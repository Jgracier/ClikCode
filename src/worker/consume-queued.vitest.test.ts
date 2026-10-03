import { describe, expect, it } from 'vitest';
import type { HarnessState } from '../session/model.js';
import { consumeQueuedTurn, type QueueStateIo } from './consume-queued.js';

function stateWith(ids: string[]): HarnessState {
  return { sessions: [{ id: 's', queuedTurns: ids.map((id) => ({ id, text: id, submittedAt: '2026-10-03T00:00:00.000Z' })) }] } as unknown as HarnessState;
}

function io(failures: number): QueueStateIo & { writes: HarnessState[]; attempts: number } {
  const result = {
    writes: [] as HarnessState[], attempts: 0,
    readState: async () => stateWith(['a', 'b']),
    writeState: async (state: HarnessState) => {
      result.attempts += 1;
      if (result.attempts <= failures) throw new Error('disk full');
      result.writes.push(state);
    },
  };
  return result;
}

describe('taking a failed queued turn out of the queue', () => {
  it('retries a failed write and consumes it', async () => {
    const store = io(2);
    expect(await consumeQueuedTurn('s', 'a', store, 3, 0)).toBe('consumed');
    expect(store.writes[0]!.sessions[0]!.queuedTurns?.map((item) => item.id)).toEqual(['b']);
  });

  it('throws once every attempt failed, instead of leaving it to run again silently', async () => {
    const store = io(10);
    await expect(consumeQueuedTurn('s', 'a', store, 3, 0)).rejects.toThrow('disk full');
    expect(store.attempts).toBe(3);
  });

  it('says gone when it is no longer queued', async () => {
    expect(await consumeQueuedTurn('s', 'zzz', io(0), 3, 0)).toBe('gone');
  });
});

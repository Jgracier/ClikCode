import { describe, expect, it, vi } from 'vitest';
const mark = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../turn/account-outcome.js', () => ({ storeQuotaRefusal: mark }));
import { createWorkEndedHandler } from './handed-off-work.js';
import type { WorkerContext } from './worker-context.js';

describe('quota recovery delivery', () => {
  it.each([false, true])('marks the original account and queues continuation without interrupting a running parent (%s)', async (turnRunning) => {
    const queued: string[] = [];
    const drainQueue = vi.fn(async () => undefined);
    const ctx = { turnRunning, io: { recordNotificationText: async (text: string, durable: boolean) => { expect(mark).toHaveBeenLastCalledWith('original-account', expect.any(Error)); expect(durable).toBe(true); queued.push(text); }, broadcastQueueChanged: vi.fn() },
      queue: { drainQueue }, idle: { scheduleIdleExit: vi.fn() } } as unknown as WorkerContext;
    createWorkEndedHandler(ctx)([{ id: 'child', kind: 'agent', label: 'Migration', prompt: 'Apply and verify', outputFile: '/tmp/child.jsonl', outcome: 'cut-off',
      tail: 'Migration applied.', limit: "You've hit your usage limit" }], { harness: 'other', accountId: 'original-account' });
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    expect(queued[0]).toContain('Migration applied.');
    expect(queued[0]).toContain('Continue from the last unfinished step');
    expect(drainQueue).toHaveBeenCalledTimes(turnRunning ? 0 : 1);
  });
});

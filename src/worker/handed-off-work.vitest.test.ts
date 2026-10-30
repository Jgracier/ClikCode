import { describe, expect, it, vi } from 'vitest';
import { createWorkEndedHandler, formatEndedWork } from './handed-off-work.js';
import type { WorkerContext } from './worker-context.js';
import type { EndedWork } from '../harness/transport/handoff-work.js';

const cutOff: EndedWork = {
  id: 'child', kind: 'agent', label: 'Migration', prompt: 'Apply and verify', outputFile: '/tmp/child.jsonl', outcome: 'cut-off',
  tail: 'Migration applied.', failure: { vendorError: true, text: "You've hit your usage limit" },
};

describe('quota recovery delivery', () => {
  it.each([false, true])('queues the continuation without interrupting a running parent (%s)', async (turnRunning) => {
    const queued: string[] = [];
    const drainQueue = vi.fn(async () => undefined);
    const ctx = { sessionId: 's1', turnRunning, io: { recordNotificationText: async (text: string, durable: boolean) => { expect(durable).toBe(true); queued.push(text); }, broadcastQueueChanged: vi.fn() },
      queue: { drainQueue }, idle: { scheduleIdleExit: vi.fn() } } as unknown as WorkerContext;
    createWorkEndedHandler(ctx)([cutOff], { harness: 'other', accountId: 'original-account' });
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    expect(queued[0]).toContain('Migration applied.');
    expect(queued[0]).toContain('Continue from the last unfinished step');
    expect(drainQueue).toHaveBeenCalledTimes(turnRunning ? 0 : 1);
  });
});

describe('taking cut-off work up again', () => {
  it('replays the task, its progress and its transcript on any harness', () => {
    const text = formatEndedWork([cutOff]);
    expect(text).toContain('Start a replacement agent on the current account');
    expect(text).toContain('Original task:\nApply and verify');
    expect(text).toContain('Progress before interruption:\nMigration applied.');
    expect(text).toContain('"/tmp/child.jsonl"');
    expect(text).not.toContain('SendMessage');
  });

  it("resumes the vendor's own agent only where its history was carried", () => {
    const text = formatEndedWork([cutOff], new Set(['child']));
    expect(text).toContain('Resume the existing native agent "child"');
    expect(text).toContain('SendMessage');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createWorkEndedHandler, formatEndedWork, recordInterruptedAgents } from './handed-off-work.js';
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

describe('agents interrupted by the worker closing their process', () => {
  it('records one durable notification naming each agent, its task and what to do, before the worker exits', async () => {
    const queued: { text: string; durable: boolean }[] = [];
    const ctx = { sessionId: 'no-such-session', io: { recordNotificationText: async (text: string, durable: boolean) => { queued.push({ text, durable }); } } } as unknown as WorkerContext;
    const count = await recordInterruptedAgents(ctx, [
      { id: 'a1', kind: 'agent', label: 'Open B5', prompt: 'Check the games endpoints' },
      { id: 'a2', kind: 'agent', label: 'Audit logs', prompt: 'Read the logs' },
      { id: '4242', kind: 'command', label: 'sleep 99' },
    ]);
    expect(count).toBe(2);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.durable).toBe(true);
    expect(queued[0]!.text).toContain('[background agent a1 was cut off: ClikCode closed the process running it before it finished.] Open B5');
    expect(queued[0]!.text).toContain('[background agent a2 was cut off');
    expect(queued[0]!.text).toContain('Original task:\nCheck the games endpoints');
    expect(queued[0]!.text).not.toContain('sleep 99');
  });

  it('records nothing when no agent was running', async () => {
    const ctx = { sessionId: 's', io: { recordNotificationText: async () => { throw new Error('should not be called'); } } } as unknown as WorkerContext;
    expect(await recordInterruptedAgents(ctx, [{ id: '1', kind: 'command', label: 'x' }])).toBe(0);
  });
});

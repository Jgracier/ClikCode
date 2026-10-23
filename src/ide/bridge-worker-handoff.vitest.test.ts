import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { MOVED_REASON } from '../worker/protocol.js';
import { CONVERSATION_HANDOFF_REASON } from '../worker/registry.js';

class FakeClient extends EventEmitter {
  initialSnapshot = Promise.resolve({ type: 'snapshot' as const, live: undefined });
}
const attach = vi.fn(async () => new FakeClient());
vi.mock('../worker/client.js', () => ({ WorkerClient: { attach } }));

const { WorkerLink } = await import('./bridge-worker.js');

describe('VS Code worker handoff', () => {
  it.each([['yields to another machine', CONVERSATION_HANDOFF_REASON], ['moves to another machine', MOVED_REASON]])('does not reclaim a chat when its worker %s', async (_name, reason) => {
    attach.mockClear();
    const enqueue = vi.fn((work: () => Promise<void>) => { void work(); });
    const link = new WorkerLink({
      channel: { send: vi.fn() }, sessionId: 'chat', closed: false, shown: true,
      enqueue, prompter: {} as never, report: vi.fn(), refreshUsage: vi.fn(), scheduleDrain: vi.fn(),
    } as never);
    const client = await link.workerFor('chat') as unknown as FakeClient;
    client.emit('event', { type: 'shutdown', reason });
    client.emit('close');
    await Promise.resolve();
    expect(enqueue).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledTimes(1);
  });
});

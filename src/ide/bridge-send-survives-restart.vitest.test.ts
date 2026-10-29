/** A message sent while its worker leaves still runs, exactly once: the first worker closes its socket without taking the
 * submit (as a worker retiring for a newer build does), the second takes it. Real WorkerLink and BridgeTurns; the workers
 * are fakes with the real client's surface. */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WorkerLink } from './bridge-worker.js';
import { BridgeTurns } from './bridge-turns.js';

vi.mock('../session/attach.js', async (original) => ({ ...(await original<object>()), prepareTurn: vi.fn(async () => undefined) }));

type Behaviour = 'leave-without-taking' | 'take-and-finish' | 'take-then-leave';
const attached: Array<{ behaviour: Behaviour; submits: number }> = [];
const script: Behaviour[] = [];

vi.mock('../worker/client.js', () => ({
  WorkerClient: {
    attach: vi.fn(async () => {
      const behaviour = script[Math.min(attached.length, script.length - 1)]!;
      const record = { behaviour, submits: 0 };
      attached.push(record);
      const client = Object.assign(new EventEmitter(), {
        sessionId: 's1',
        initialSnapshot: Promise.resolve({ type: 'snapshot' }),
        close: () => undefined,
        send: (command: { type: string }) => {
          if (command.type !== 'submit') return;
          record.submits++;
          setTimeout(() => {
            if (behaviour === 'leave-without-taking') { client.emit('event', { type: 'shutdown', reason: 'replaced by a newer ClikCode build' }); client.emit('close'); return; }
            client.emit('event', { type: 'waiting-start' });
            if (behaviour === 'take-then-leave') { client.emit('close'); return; }
            client.emit('event', { type: 'waiting-stop' });
          }, 5);
        },
      });
      return client;
    }),
  },
}));

function bridgeOf() {
  const sent: Array<{ type?: string }> = [];
  const host: Record<string, unknown> = {
    channel: { send: (message: { type?: string }) => { sent.push(message); } },
    sessionId: 's1', closed: false, shown: false,
    prompter: {}, enqueue: () => undefined, report: () => undefined, refreshUsage: async () => undefined, scheduleDrain: () => undefined,
    prepareRoute: async () => undefined,
  };
  const link = new WorkerLink(host as never);
  host.link = link;
  return { turns: new BridgeTurns(host as never), sent };
}

describe('a message sent while its worker leaves', () => {
  it('runs on the replacement worker, once', async () => {
    attached.length = 0; script.length = 0; script.push('leave-without-taking', 'take-and-finish');
    const { turns, sent } = bridgeOf();
    await turns.runTurn('s1', 'hello', { echo: true });
    expect(attached.map((worker) => worker.submits)).toEqual([1, 1]);
    expect(sent.filter((message) => message.type === 'turn-start')).toHaveLength(1);
  }, 15_000);

  it('is not sent a second time when the worker had taken it before it left', async () => {
    attached.length = 0; script.length = 0; script.push('take-then-leave', 'take-and-finish');
    const { turns } = bridgeOf();
    await expect(turns.runTurn('s1', 'hello', { echo: true })).rejects.toThrow();
    expect(attached.map((worker) => worker.submits)).toEqual([1]);
  }, 15_000);
});

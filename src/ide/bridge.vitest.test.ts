/** An editor following a turn it did not start still sends what was queued
 * behind it.
 *
 * The editor's drain used to run only after its own `open` and its own turns,
 * so a message queued from VS Code while a terminal's turn ran (or one the
 * worker started) sat until the user sent something else. */
import { describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';
import { IdeBridge } from './bridge.js';
import type { WorkerEvent } from '../worker/protocol.js';
import { IDE_PROTOCOL } from './protocol.js';

interface Internals {
  sessionId: string | undefined;
  workerTurnRunning: boolean;
  turnWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  work: Promise<void>;
  drainQueue(): Promise<void>;
  onWorkerEvent(sessionId: string, client: unknown, event: WorkerEvent): void;
}

const setup = () => {
  const bridge = new IdeBridge({} as Conf, { send: () => undefined });
  const inner = bridge as unknown as Internals;
  inner.sessionId = 's1';
  const drains = vi.fn(async () => undefined);
  inner.drainQueue = drains;
  const event = (value: WorkerEvent): void => inner.onWorkerEvent('s1', {}, value);
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await inner.work; };
  return { inner, drains, event, settle };
};

describe('the editor bridge and the queue', () => {
  it('sends what was queued when a turn it only followed ends', async () => {
    const { inner, drains, event, settle } = setup();
    event({ type: 'waiting-start' } as WorkerEvent);
    expect(inner.workerTurnRunning).toBe(true);
    event({ type: 'queue-changed' });
    await settle();
    expect(drains, 'nothing is sent into a running turn').not.toHaveBeenCalled();
    event({ type: 'waiting-stop' } as WorkerEvent);
    await settle();
    expect(drains).toHaveBeenCalledTimes(1);
  });

  it('drains on a queue change while nothing runs, once however many arrive', async () => {
    const { drains, event, settle } = setup();
    event({ type: 'queue-changed' });
    event({ type: 'queue-changed' });
    event({ type: 'queue-changed' });
    await settle();
    expect(drains).toHaveBeenCalledTimes(1);
  });

  it('leaves its own turn\'s drain to the turn\'s caller', async () => {
    const { inner, drains, event, settle } = setup();
    const resolved = vi.fn();
    inner.turnWaiter = { resolve: resolved, reject: () => undefined };
    event({ type: 'queue-changed' });
    event({ type: 'waiting-stop' } as WorkerEvent);
    await settle();
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(drains).not.toHaveBeenCalled();
  });

  it('waits out the running turn when its submit is queued, rather than resending into it', async () => {
    const { inner, event } = setup();
    const resolved = vi.fn();
    event({ type: 'waiting-start' } as WorkerEvent);
    inner.turnWaiter = { resolve: resolved, reject: () => undefined };
    event({ type: 'submit-queued', queuedTurnId: 'q1' });
    expect(resolved, 'resolving now would resubmit into the running turn').not.toHaveBeenCalled();
    event({ type: 'waiting-stop' } as WorkerEvent);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the turn it was queued behind had already ended', () => {
    const { inner, event } = setup();
    const resolved = vi.fn();
    inner.turnWaiter = { resolve: resolved, reject: () => undefined };
    event({ type: 'submit-queued', queuedTurnId: 'q1' });
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it('does not loop when draining itself changes the queue', async () => {
    const { inner, event, settle } = setup();
    let calls = 0;
    inner.drainQueue = async () => {
      calls += 1;
      // Consuming the head is itself a queue change the worker broadcasts.
      if (calls === 1) event({ type: 'queue-changed' });
    };
    event({ type: 'queue-changed' });
    await settle();
    expect(calls).toBe(2);
  });
});

describe('the editor bridge handshake', () => {
  it('announces the protocol version the editor checks compatibility against', () => {
    const sent: unknown[] = [];
    const bridge = new IdeBridge({} as Conf, { send: (message) => { sent.push(message); } });
    bridge.start();
    for (const timer of (bridge as unknown as { timers: NodeJS.Timeout[] }).timers) clearInterval(timer);
    expect(sent[0]).toMatchObject({ type: 'ready', protocol: IDE_PROTOCOL.version });
    expect(IDE_PROTOCOL.oldestSupported).toBeLessThanOrEqual(IDE_PROTOCOL.version);
  });
});

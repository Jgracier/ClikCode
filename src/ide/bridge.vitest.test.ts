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
import { IDE_PROTOCOL } from './protocol-version.js';

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

describe('the editor bridge draining a stuck queue', () => {
  it('sends a queued message that stays at the head once, not again and again', async () => {
    const { readState } = await import('../session/state/read.js');
    const { writeState } = await import('../session/state/write.js');
    const state = await readState();
    const now = new Date().toISOString();
    state.sessions.push({
      id: 'stuck', conversationId: 'stuck', route: 'local', accountId: null, provider: 'anthropic', model: null, nativeHarness: 'claude',
      effort: 'medium', createdAt: now, updatedAt: now, status: 'active',
      messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'done' }],
      queuedTurns: [{ id: 'q1', text: 'send me', submittedAt: now }],
    } as never);
    await writeState(state);
    const bridge = new IdeBridge({} as Conf, { send: () => undefined });
    const inner = bridge as unknown as Internals & { execute: (line: string, options: unknown) => Promise<void> };
    inner.sessionId = 'stuck';
    // Its run fails and the queue cannot be changed: q1 stays first.
    const execute = vi.fn(async () => undefined);
    inner.execute = execute;
    await inner.drainQueue();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('the editor bridge and a pending sign-in', () => {
  type Queue = { enqueue(job: () => Promise<void>): void; work: Promise<void> };

  it('lets the queue move on while a sign-in waits, and carries on after it', async () => {
    const bridge = new IdeBridge({} as Conf, { send: () => undefined });
    const inner = bridge as unknown as Queue;
    const order: string[] = [];
    let finishSignIn!: () => void;
    inner.enqueue(async () => {
      const screen = bridge.prompter.signInScreen('Vendor');
      await new Promise<void>((resolve) => { finishSignIn = resolve; });
      screen.stop();
      order.push('signed in');
    });
    inner.enqueue(async () => { order.push('next request'); });
    await inner.work;
    expect(order, 'the request behind the sign-in ran').toEqual(['next request']);
    finishSignIn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['next request', 'signed in']);
  });

  it('still runs jobs one at a time otherwise', async () => {
    const bridge = new IdeBridge({} as Conf, { send: () => undefined });
    const inner = bridge as unknown as Queue;
    const order: string[] = [];
    inner.enqueue(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); order.push('first'); });
    inner.enqueue(async () => { order.push('second'); });
    await inner.work;
    expect(order).toEqual(['first', 'second']);
  });
});

describe('the editor bridge shutting down', () => {
  it('is one shutdown however many ask, so an exit waits for the close already writing', async () => {
    const bridge = new IdeBridge({} as Conf, { send: () => undefined });
    const first = bridge.shutdown();
    expect(bridge.shutdown(), 'the disconnect after `close` waits on the same work').toBe(first);
    await first;
  });
});

describe('the editor bridge running a `!` line', () => {
  it('shows its output once: as the transcript message, not also as an output card', async () => {
    const { readState } = await import('../session/state/read.js');
    const { writeState } = await import('../session/state/write.js');
    const state = await readState();
    const now = new Date().toISOString();
    state.sessions.push({
      id: 'shell', conversationId: 'shell', route: 'local', accountId: null, provider: 'anthropic', model: null, nativeHarness: 'claude',
      effort: 'medium', createdAt: now, updatedAt: now, status: 'active', workspace: process.cwd(), messages: [],
    } as never);
    await writeState(state);
    const bridge = new IdeBridge({} as Conf, { send: () => undefined });
    const inner = bridge as unknown as { sessionId: string; dispatch(line: string, fromQueuedCommand: boolean): Promise<unknown> };
    inner.sessionId = 'shell';
    // What reaches the editor: runIdeBridge turns each JSON line on stdout
    // into an `output` event, and drops it while the bridge is quiet.
    const reaching: unknown[] = [];
    const previousMode = process.env.CLIKCODE_OUTPUT_MODE;
    process.env.CLIKCODE_OUTPUT_MODE = 'json';
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      let payload: unknown;
      try { payload = JSON.parse(String(chunk)); } catch { payload = undefined; }
      if (payload && !bridge.quietOutput) reaching.push(payload);
      return true;
    }) as typeof process.stdout.write;
    try { await inner.dispatch('!echo shell-once', false); } finally {
      process.stdout.write = original;
      if (previousMode === undefined) delete process.env.CLIKCODE_OUTPUT_MODE; else process.env.CLIKCODE_OUTPUT_MODE = previousMode;
    }
    const after = (await readState({ transcripts: ['shell'] })).sessions.find((item) => item.id === 'shell')!;
    expect(after.messages?.at(-1)?.content).toContain('shell-once');
    expect(reaching.filter((payload) => (payload as { panel?: unknown }).panel === 'shell'), 'the transcript already shows it').toEqual([]);
  });
});


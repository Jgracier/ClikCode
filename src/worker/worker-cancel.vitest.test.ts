/** Stop and the terminal event, at the worker: the one place that knows
 * whether a turn is running. In-process, with the turn itself faked. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'node:net';
import type { HarnessSession } from '../session/model.js';
import { turnCancelledError } from '../agent/cancellation.js';
import type { WorkerEvent } from './protocol.js';

const turn = vi.hoisted(() => ({
  run: undefined as undefined | ((signal: AbortSignal) => Promise<void>),
  signals: [] as AbortSignal[],
}));
vi.mock('../turn/session-turn.js', () => ({
  runSessionTurn: async (_config: unknown, _id: string, _text: string, signal: AbortSignal) => { turn.signals.push(signal); await turn.run?.(signal); },
}));
vi.mock('../turn/turn-journal.js', () => ({
  discardInterruptedTurn: vi.fn(async () => undefined), preserveInterruptedTurn: vi.fn(async () => undefined), markFailedTurn: vi.fn(async () => undefined),
}));
vi.mock('../agent/mcp/manager.js', () => ({ releaseMcp: vi.fn(async () => undefined), prepareMcp: vi.fn() }));
vi.mock('../harness/transport/native/held-vendor.js', () => ({ hasHeldVendorProcess: () => false, stopHeldVendorProcess: vi.fn(async () => undefined) }));
vi.mock('../turn/vendor-process.js', () => ({ persistentWorkRunning: async () => false, closePersistentTransport: vi.fn(async () => undefined) }));
vi.mock('./consume-queued.js', () => ({ consumeQueuedTurn: vi.fn(async () => undefined) }));

const { BroadcastObserver } = await import('./broadcast-observer.js');
const { createWorkerQueue } = await import('./worker-queue.js');
const { createTurnRunner } = await import('./worker-turn.js');
const { createCommandHandler } = await import('./worker-commands.js');

const session = { id: 's1', queuedTurns: [{ id: 'q1', text: 'hello' }] } as unknown as HarnessSession;

function fakeSocket(): { socket: Socket; events: WorkerEvent[] } {
  const events: WorkerEvent[] = [];
  const socket = { destroyed: false, writableLength: 0, write: (frame: string) => { events.push(JSON.parse(frame) as WorkerEvent); return true; }, end: () => undefined } as unknown as Socket;
  return { socket, events };
}

function build(options: { sessionReadMs?: number; sessionFails?: boolean } = {}) {
  const observer = new BroadcastObserver();
  const alice = fakeSocket();
  observer.attach(alice.socket);
  const ctx = {
    sessionId: 's1', config: {}, observer, token: 't', agentSession: { notifications: [] },
    turnRunning: false, activeQueuedTurnId: undefined, draining: false, stalledQueuedTurnId: undefined, idleTimer: undefined,
    activeController: undefined, activeLiveInput: undefined, activeSubmissions: undefined, activeRestoreDraft: undefined,
    submitsInFlight: 0, pendingCancel: undefined, stopAnnounced: false, resumingTurn: false, retireWhenIdle: false,
    vendorBackground: { busy: false, settled: async () => undefined, saveSuperseded: async () => undefined, userTurnEnded: () => undefined },
    resumeWaiter: { pending: false, cancel: async () => undefined, check: async () => undefined },
    idle: { vendorUsed: () => undefined, scheduleIdleExit: () => undefined, retireBlocker: () => undefined },
    io: {
      currentSessionAndAccount: async () => {
        if (options.sessionReadMs) await new Promise((resolveRead) => setTimeout(resolveRead, options.sessionReadMs));
        if (options.sessionFails) throw new Error('conversation not found');
        return { session };
      },
      broadcastNotice: () => undefined, broadcastQueueChanged: () => undefined, showEveryWindow: () => undefined, recordNotifications: async () => undefined,
    },
  } as never as import('./worker-context.js').WorkerContext;
  ctx.queue = createWorkerQueue(ctx);
  ctx.runTurn = createTurnRunner(ctx);
  const handle = createCommandHandler(ctx);
  const connection = { socket: alice.socket, attached: true } as never;
  const send = (command: import('./protocol.js').ClientCommand, from = alice.socket): Promise<void> => handle(from, command, connection);
  const types = (): string[] => alice.events.map((event) => event.type);
  return { ctx, send, alice, types };
}

const settle = (ms = 30): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

beforeEach(() => { turn.run = undefined; turn.signals = []; });

describe('a Stop before the turn has started', () => {
  it('aborts the turn the moment it starts, and ends it cancelled with the draft restored', async () => {
    const { ctx, send, alice, types } = build({ sessionReadMs: 40 });
    turn.run = async (signal) => { if (signal.aborted) throw turnCancelledError(); await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(turnCancelledError()))); };
    // The submit is still reading the conversation when the Stop arrives.
    const submitted = send({ type: 'submit', text: 'hello', echo: true, queuedTurnId: 'q1' } as never);
    await settle(5);
    expect(ctx.activeController).toBeUndefined();
    await send({ type: 'cancel', restoreDraft: true });
    await submitted;
    await settle(150);
    expect(types()).toContain('stopping');
    expect(alice.events.some((event) => event.type === 'restore-draft' && event.text === 'hello')).toBe(true);
    expect(alice.events.filter((event) => event.type === 'waiting-stop')).toEqual([{ type: 'waiting-stop', stopped: true }]);
    expect(ctx.turnRunning).toBe(false);
    expect(ctx.pendingCancel).toBeUndefined();
  });

  it('repeated Stops are idempotent and keep the first draft decision', async () => {
    const { ctx, send, alice, types } = build({ sessionReadMs: 40 });
    turn.run = async (signal) => { if (signal.aborted) throw turnCancelledError(); };
    const submitted = send({ type: 'submit', text: 'hello', echo: true, queuedTurnId: 'q1' } as never);
    await settle(5);
    await send({ type: 'cancel', restoreDraft: false });
    await send({ type: 'cancel', restoreDraft: true });
    await send({ type: 'cancel', restoreDraft: true });
    await submitted;
    await settle(150);
    expect(types().filter((type) => type === 'stopping')).toHaveLength(1);
    expect(alice.events.some((event) => event.type === 'restore-draft')).toBe(false);
    expect(types().filter((type) => type === 'waiting-stop')).toHaveLength(1);
    expect(ctx.turnRunning).toBe(false);
  });

  it('is told the Stop had nothing to end when the submit is rejected', async () => {
    const { ctx, send, alice, types } = build({ sessionReadMs: 30, sessionFails: true });
    const submitted = send({ type: 'submit', text: 'hello', echo: true, queuedTurnId: 'q1' } as never);
    await settle(5);
    await send({ type: 'cancel', restoreDraft: false });
    await submitted;
    expect(types()).toContain('submit-rejected');
    expect(alice.events).toContainEqual({ type: 'stop-done', nothing: true });
    expect(ctx.pendingCancel).toBeUndefined();
  });
});

describe('a Stop with nothing in flight', () => {
  it('answers that there is nothing to stop', async () => {
    const { send, alice } = build();
    await send({ type: 'cancel', restoreDraft: false });
    expect(alice.events).toEqual([{ type: 'stop-done', nothing: true }]);
  });
});

describe('every accepted submit ends in one waiting-stop', () => {
  it('when the conversation cannot be read at the turn\'s end', async () => {
    const { ctx, send, alice, types } = build({ sessionFails: true });
    // The submit itself cannot read it either: rejected, one terminal event.
    await send({ type: 'submit', text: 'x', echo: true, queuedTurnId: 'q1' } as never);
    expect(types().filter((type) => type === 'waiting-stop')).toHaveLength(1);
    expect(alice.events.some((event) => event.type === 'submit-rejected')).toBe(true);
    expect(ctx.turnRunning).toBe(false);
  });

  it('when the end-of-turn read fails after a turn that ran', async () => {
    const { ctx, send, types } = build();
    let reads = 0;
    const read = ctx.io.currentSessionAndAccount;
    ctx.io.currentSessionAndAccount = async () => { reads++; if (reads > 1) throw new Error('state gone'); return read(); };
    await send({ type: 'submit', text: 'x', echo: true } as never);
    await settle(150);
    expect(types().filter((type) => type === 'waiting-stop')).toHaveLength(1);
    expect(ctx.turnRunning).toBe(false);
  });

  it('when a failed turn cannot even be journaled as failed', async () => {
    const { markFailedTurn } = await import('../turn/turn-journal.js');
    vi.mocked(markFailedTurn).mockRejectedValueOnce(new Error('disk full'));
    const { ctx, send, types } = build();
    turn.run = async () => { throw new Error('model down'); };
    await send({ type: 'submit', text: 'x', echo: true } as never);
    await settle(150);
    expect(types().filter((type) => type === 'waiting-stop')).toHaveLength(1);
    expect(types()).toContain('turn-error');
    expect(ctx.turnRunning).toBe(false);
  });

  it('when the settling of a stopped turn throws', async () => {
    const { discardInterruptedTurn } = await import('../turn/turn-journal.js');
    vi.mocked(discardInterruptedTurn).mockRejectedValueOnce(new Error('disk full'));
    const { ctx, send, types } = build();
    turn.run = async () => { throw turnCancelledError(); };
    await send({ type: 'submit', text: 'x', echo: true } as never);
    await settle(150);
    expect(types().filter((type) => type === 'waiting-stop')).toHaveLength(1);
    expect(ctx.turnRunning).toBe(false);
  });
});

describe('settings-changed', () => {
  it('is held by the worker for the running turn', async () => {
    const { ctx, send } = build();
    (ctx as { liveSettings: unknown }).liveSettings = new (await import('../turn/live-settings.js')).LiveSettings({ route: 'gateway', model: null, effort: 'low', speed: undefined, permissionMode: 'ask' });
    await send({ type: 'settings-changed', settings: { effort: 'high', permissionMode: 'bypass' } });
    expect(ctx.liveSettings.effort).toBe('high');
    expect(ctx.liveSettings.permissionMode).toBe('bypass');
  });
});

describe('a Stop that fails while stopping vendor work', () => {
  it('still says it is done, so a window is not left stopping', async () => {
    const { ctx, send, alice } = build();
    ctx.vendorBackground = { ...ctx.vendorBackground, busy: true } as never;
    const { closePersistentTransport } = await import('../turn/vendor-process.js');
    vi.mocked(closePersistentTransport).mockRejectedValueOnce(new Error('vendor gone'));
    await expect(send({ type: 'cancel', restoreDraft: false })).rejects.toThrow('vendor gone');
    expect(alice.events.map((event) => event.type)).toEqual(['stopping', 'stop-done']);
  });
});

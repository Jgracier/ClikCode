/** Where no vendor threshold carries ClikCode's, ClikCode compacts a conversation by itself at the
 * boundary after a turn whose context passed the threshold, as a turn of its own, before anything
 * queued runs; a vendor whose own threshold carries it is not compacted a second time. In-process,
 * with the turns faked. */
import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'node:net';
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { WorkerEvent } from './protocol.js';

const turns = vi.hoisted(() => ({ texts: [] as string[], usage: 200_000 }));
vi.mock('../turn/session-turn.js', () => ({
  runSessionTurn: async (_config: unknown, id: string, text: string) => {
    turns.texts.push(text);
    const { readState } = await import('../session/state/read.js');
    const { writeState } = await import('../session/state/write.js');
    const state = await readState({ transcripts: [id] });
    const session = state.sessions.find((item) => item.id === id)!;
    session.messages = [...session.messages ?? [], { role: 'user', content: text }, { role: 'assistant', content: 'ok' }];
    // A compaction's own turn leaves the context small; any other turn leaves it at `turns.usage`.
    session.lastUsage = { contextUsed: text === '/compact' ? 30_000 : turns.usage, at: new Date().toISOString() };
    if (text === '/compact') session.compaction = { at: new Date().toISOString(), through: session.messages.length };
    await writeState(state);
  },
}));
vi.mock('../turn/turn-journal.js', () => ({
  discardInterruptedTurn: vi.fn(async () => undefined), preserveInterruptedTurn: vi.fn(async () => undefined), markFailedTurn: vi.fn(async () => undefined),
}));
vi.mock('../agent/mcp/manager.js', () => ({ releaseMcp: vi.fn(async () => undefined), prepareMcp: vi.fn() }));

const { writeState } = await import('../session/state/write.js');
const { BroadcastObserver } = await import('./broadcast-observer.js');
const { createWorkerQueue } = await import('./worker-queue.js');
const { createTurnRunner } = await import('./worker-turn.js');
const { createCommandHandler } = await import('./worker-commands.js');

const chat = (overrides: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', conversationId: 's1', route: 'local', accountId: 'a1', provider: 'opencode', model: null, effort: 'medium', permissionMode: 'ask',
  nativeHarness: 'opencode', nativeSessionId: 'n1', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', ...overrides,
});

function build() {
  const observer = new BroadcastObserver();
  const events: WorkerEvent[] = [];
  const socket = { destroyed: false, writableLength: 0, write: (frame: string) => { events.push(JSON.parse(frame) as WorkerEvent); return true; }, end: () => undefined } as unknown as Socket;
  observer.attach(socket);
  const ctx = {
    sessionId: 's1', config: {}, observer, token: 't', agentSession: { notifications: [] },
    turnRunning: false, activeQueuedTurnId: undefined, draining: false, stalledQueuedTurnId: undefined, idleTimer: undefined,
    activeController: undefined, activeLiveInput: undefined, activeSubmissions: undefined, activeRestoreDraft: undefined,
    submitsInFlight: 0, shuttingDown: false, pendingCancel: undefined, stopAnnounced: false, resumingTurn: false, retireWhenIdle: false,
    vendorBackground: { busy: false, settled: async () => undefined, saveSuperseded: async () => undefined, userTurnEnded: () => undefined },
    outOfTurn: { relay: () => undefined, active: false, settle: async () => undefined },
    resumeWaiter: { pending: false, cancel: async () => undefined, check: async () => undefined },
    idle: { vendorUsed: () => undefined, scheduleIdleExit: () => undefined, retireBlocker: () => undefined },
    io: {
      currentSessionAndAccount: async () => ({ session: chat() }),
      note: (message: string) => observer.activity(message), broadcastNotice: () => undefined, broadcastQueueChanged: () => undefined, showEveryWindow: () => undefined, recordNotifications: async () => undefined,
    },
  } as never as import('./worker-context.js').WorkerContext;
  ctx.queue = createWorkerQueue(ctx);
  ctx.runTurn = createTurnRunner(ctx);
  const handle = createCommandHandler(ctx);
  const send = (command: import('./protocol.js').ClientCommand): Promise<void> => handle(socket, command, { socket, attached: true } as never);
  return { ctx, send, events };
}

const account = (provider: string) => ({ id: 'a1', provider, label: provider, authKind: 'oauth', models: [], status: 'ready' });
const stateWith = (session: HarnessSession, compactAt?: number): HarnessState => ({
  sessions: [session], accounts: [account(session.nativeHarness!)], invocations: [], providerSettings: {},
  globalSettings: { effort: 'medium', permissionMode: 'ask', ...(compactAt ? { compactAt } : {}) },
} as unknown as HarnessState);

describe('compacting by itself', () => {
  it('runs the compaction after a turn that passed the threshold, says "Compacting…", and not again after it', async () => {
    turns.texts = [];
    turns.usage = 200_000;
    await writeState(stateWith(chat()));
    const { ctx, send, events } = build();
    await send({ type: 'submit', text: 'do the thing', echo: true });
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'waiting-stop')).toHaveLength(2), { timeout: 5_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(turns.texts).toEqual(['do the thing', '/compact']);
    const starts = events.filter((event) => event.type === 'waiting-start');
    expect(starts[1]).toEqual({ type: 'waiting-start', message: 'Compacting…' });
    expect(ctx.turnRunning).toBe(false);
  });

  it('does nothing under the threshold the user set', async () => {
    turns.texts = [];
    turns.usage = 200_000;
    await writeState(stateWith(chat(), 300_000));
    const { send, events } = build();
    await send({ type: 'submit', text: 'do the thing', echo: true });
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'waiting-stop')).toHaveLength(1), { timeout: 5_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(turns.texts).toEqual(['do the thing']);
  });

  it('leaves a vendor whose own threshold carries ClikCode\'s to compact itself (Claude Code), not a second time after the turn', async () => {
    turns.texts = [];
    turns.usage = 65_000; // past the threshold (50k), short of its backstop multiple (75k)
    await writeState(stateWith(chat({ nativeHarness: 'claude', provider: 'anthropic' })));
    const { send, events } = build();
    await send({ type: 'submit', text: 'do the thing', echo: true });
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'waiting-stop')).toHaveLength(1), { timeout: 5_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(turns.texts).toEqual(['do the thing']);
  });

  it('compacts a vendor launched with the threshold after all when it plainly ignored it', async () => {
    turns.texts = [];
    turns.usage = 400_000;
    await writeState(stateWith(chat({ nativeHarness: 'claude', provider: 'anthropic' })));
    const { send, events } = build();
    await send({ type: 'submit', text: 'do the thing', echo: true });
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'waiting-stop')).toHaveLength(2), { timeout: 5_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(turns.texts).toEqual(['do the thing', '/compact']);
  });
});

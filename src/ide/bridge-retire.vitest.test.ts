/** The editor's bridge leaves for a newer installed build the way a session
 * worker does: only once the build changed, and only while quiet -- nothing
 * it was asked still being answered, no turn it follows running, nothing
 * open in the editor, and nothing happening for the quiet time. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';
import { watchForNewerBuild } from './bridge-retire.js';
import { IdeBridge } from './bridge.js';
import { MultiplexHost, type MuxChat } from './bridge-mux.js';
import type { IdeEvent, IdeHostEvent, IdeRequest } from './protocol.js';
import type { IdeChannel } from './prompter.js';
import type { WorkerEvent } from '../worker/protocol.js';

vi.mock('../session/attach.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session/attach.js')>()),
  leaveConversation: vi.fn(async () => undefined),
}));
vi.mock('../commands/ai/local-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/ai/local-model.js')>()),
  reconcileLocalModelLeases: vi.fn(async () => undefined),
}));

const QUIET = 30_000;
const WATCH = 1_000;

describe('watching for a newer build', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const watch = (state: { build: string; blocker?: string; activityAt: number }) => {
    const retire = vi.fn();
    const handle = watchForNewerBuild({
      startBuild: 'old', currentBuild: () => state.build, blocker: () => state.blocker,
      lastActivityAt: () => state.activityAt, retire, watchMs: WATCH, quietMs: QUIET,
    });
    return { retire, handle };
  };

  it('stays on the build it started with for as long as that is the one installed', async () => {
    const { retire, handle } = watch({ build: 'old', activityAt: Date.now() - 10 * QUIET });
    await vi.advanceTimersByTimeAsync(10 * QUIET);
    expect(retire).not.toHaveBeenCalled();
    handle.stop();
  });

  it('leaves once a newer build is installed and nothing has happened for the quiet time, once', async () => {
    const state = { build: 'old', activityAt: Date.now() };
    const { retire } = watch(state);
    await vi.advanceTimersByTimeAsync(WATCH * 3);
    state.build = 'new';
    // Something happened a moment ago: not yet.
    await vi.advanceTimersByTimeAsync(QUIET - 5 * WATCH);
    expect(retire).not.toHaveBeenCalled();
    state.activityAt = Date.now();
    await vi.advanceTimersByTimeAsync(QUIET - WATCH);
    expect(retire, 'activity pushes it on').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * WATCH);
    expect(retire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * QUIET);
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it('never leaves while something holds it, however long it has been quiet', async () => {
    const state: { build: string; blocker?: string; activityAt: number } = { build: 'new', blocker: 'a turn is running', activityAt: Date.now() - 10 * QUIET };
    const { retire } = watch(state);
    await vi.advanceTimersByTimeAsync(10 * QUIET);
    expect(retire).not.toHaveBeenCalled();
    state.blocker = undefined;
    await vi.advanceTimersByTimeAsync(WATCH);
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it('does not take an entry it cannot read (an install under way) for a new build', async () => {
    const { retire } = watch({ build: '', activityAt: 0 });
    await vi.advanceTimersByTimeAsync(10 * QUIET);
    expect(retire).not.toHaveBeenCalled();
  });
});

interface Internals {
  sessionId: string | undefined;
  workerTurnRunning: boolean;
  turns: { send(text: string, id?: string): Promise<void> };
  work: Promise<void>;
  drainQueue(): Promise<void>;
  onWorkerEvent(sessionId: string, client: unknown, event: WorkerEvent): void;
}

describe('what holds a bridge where it is', () => {
  const setup = () => {
    const sent: IdeEvent[] = [];
    const bridge = new IdeBridge({} as Conf, { send: (event) => sent.push(event) });
    const inner = bridge as unknown as Internals;
    inner.sessionId = 's1';
    return { bridge, inner, sent };
  };

  it('a request still being answered holds it, and its end counts as activity', async () => {
    const { bridge, inner } = setup();
    let finish!: () => void;
    inner.turns.send = () => new Promise<void>((resolve) => { finish = resolve; });
    expect(bridge.retireBlocker()).toBeUndefined();
    bridge.handle({ type: 'send', text: 'hello', id: 'm1' });
    expect(bridge.retireBlocker()).toBe('a request is being answered');
    bridge.lastActivityAt = 0;
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.retireBlocker()).toBeUndefined();
    expect(bridge.lastActivityAt).toBeGreaterThan(0);
  });

  it('a turn it follows (another client\'s, or the worker\'s own) holds it until it ends', async () => {
    const { bridge, inner } = setup();
    inner.drainQueue = async () => undefined;
    inner.onWorkerEvent('s1', {}, { type: 'waiting-start' } as WorkerEvent);
    expect(bridge.retireBlocker()).toBe('a turn is running');
    inner.onWorkerEvent('s1', {}, { type: 'waiting-stop' } as WorkerEvent);
    // The drain the turn's end schedules is in flight until it has run.
    expect(bridge.retireBlocker()).toBe('a request is being answered');
    for (let i = 0; i < 5; i += 1) await inner.work;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.retireBlocker()).toBeUndefined();
  });

  it('a picker open in the editor holds it', async () => {
    const { bridge, sent } = setup();
    const choice = bridge.prompter.select('Pick one', [{ label: 'a', value: 1 }]);
    expect(bridge.retireBlocker()).toBe('a picker or sign-in is open');
    const asked = sent.find((event) => event.type === 'ui-request') as Extract<IdeEvent, { type: 'ui-request' }>;
    bridge.handle({ type: 'ui-response', id: asked.id, result: { index: 0 } });
    await choice;
    expect(bridge.retireBlocker()).toBeUndefined();
  });

  it('counts what the editor does and what is relayed to it, not the polls of an idle chat', () => {
    const { bridge, inner } = setup();
    bridge.lastActivityAt = 0;
    bridge.handle({ type: 'visible', visible: false });
    bridge.handle({ type: 'watch-conversations', on: false });
    expect(bridge.lastActivityAt).toBe(0);
    inner.onWorkerEvent('s1', {}, { type: 'delta', text: 'hi', mode: 'append' } as WorkerEvent);
    expect(bridge.lastActivityAt).toBeGreaterThan(0);
    bridge.lastActivityAt = 0;
    bridge.handle({ type: 'approval-response', id: 'x', approved: true });
    expect(bridge.lastActivityAt).toBeGreaterThan(0);
  });
});

class QuietChat implements MuxChat {
  quietOutput = 0;
  conversation: string | undefined = 's1';
  blocker: string | undefined;
  lastActivityAt = 0;
  shutdowns = 0;
  constructor(readonly channel: IdeChannel, private readonly order: string[]) {}
  start(): void { this.channel.send({ type: 'ready', version: 't', pid: 1 }); }
  handle(_request: IdeRequest): void { /* nothing */ }
  retireBlocker(): string | undefined { return this.blocker; }
  async shutdown(): Promise<void> { this.shutdowns += 1; this.order.push('chat shutdown'); }
}

describe('a shared bridge process leaving for a newer build', () => {
  const setup = () => {
    const sent: IdeHostEvent[] = [];
    const order: string[] = [];
    const chats: QuietChat[] = [];
    const host = new MultiplexHost((event) => { sent.push(event); order.push(event.type); }, (channel) => {
      const chat = new QuietChat(channel, order);
      chats.push(chat);
      return chat;
    });
    host.handle({ type: 'chat-attach', chat: 'a' });
    host.handle({ type: 'chat-attach', chat: 'b' });
    order.length = 0;
    sent.length = 0;
    return { host, sent, order, chats };
  };

  it('is held by any one chat, and is as recent as its most recent chat', () => {
    const { host, chats } = setup();
    expect(host.retireBlocker()).toBeUndefined();
    chats[1]!.blocker = 'a turn is running';
    expect(host.retireBlocker()).toBe('a turn is running');
    chats[1]!.blocker = undefined;
    chats[0]!.lastActivityAt = Date.now() + 5_000;
    expect(host.lastActivityAt).toBe(chats[0]!.lastActivityAt);
  });

  it('says host-retiring before anything else, then closes every chat as on a disconnect', async () => {
    const { host, order, chats, sent } = setup();
    await host.retire();
    expect(order[0]).toBe('host-retiring');
    expect(sent[0]).toEqual({ type: 'host-retiring', reason: 'newer-build' });
    expect(chats.map((chat) => chat.shutdowns)).toEqual([1, 1]);
    expect(sent.filter((event) => event.type === 'chat-closed')).toHaveLength(2);
    // Nothing more is taken once it is leaving.
    host.handle({ type: 'chat-attach', chat: 'c' });
    expect(chats).toHaveLength(2);
    await host.retire();
    expect(sent.filter((event) => event.type === 'host-retiring')).toHaveLength(1);
  });
});

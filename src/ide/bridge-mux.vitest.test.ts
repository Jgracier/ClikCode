/** One bridge process for every chat of an editor window: each chat gets its
 * own bridge, its own requests and its own output, and leaves alone. */
import { describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';
import { MultiplexHost, type MuxChat } from './bridge-mux.js';
import type { BridgeSiblings } from './bridge.js';
import type { IdeChannel } from './prompter.js';
import type { IdeHostEvent, IdeRequest } from './protocol.js';

vi.mock('../session/attach.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session/attach.js')>()),
  leaveConversation: vi.fn(async () => undefined),
}));
vi.mock('../commands/ai/local-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/ai/local-model.js')>()),
  reconcileLocalModelLeases: vi.fn(async () => undefined),
}));

class FakeChat implements MuxChat {
  handled: IdeRequest[] = [];
  shutdowns = 0;
  quietOutput = 0;
  conversation: string | undefined;
  lastActivityAt = 0;
  retireBlocker(): string | undefined { return undefined; }
  constructor(readonly channel: IdeChannel, readonly siblings: BridgeSiblings, private readonly routed: () => IdeChannel) {}
  start(): void { this.channel.send({ type: 'ready', version: 't', pid: 1 }); }
  handle(request: IdeRequest): void {
    this.handled.push(request);
    // A command printing its result -- later, after an await and a timer,
    // as real commands do: it still reaches this chat only.
    if (request.type === 'send') {
      void Promise.resolve().then(() => setTimeout(() => this.routed().send({ type: 'output', payload: { text: request.text } }), 1));
    }
  }
  async shutdown(): Promise<void> { this.shutdowns += 1; }
}

const setup = () => {
  const sent: IdeHostEvent[] = [];
  const chats: FakeChat[] = [];
  let host: MultiplexHost;
  host = new MultiplexHost((event) => sent.push(event), (channel, siblings) => {
    const chat = new FakeChat(channel, siblings, () => host.routed);
    chats.push(chat);
    return chat;
  });
  return { host, sent, chats };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('one bridge process serving several chats', () => {
  it('gives each chat its own bridge, ready, requests and output', async () => {
    const { host, sent, chats } = setup();
    host.handle({ type: 'chat-attach', chat: 'a' });
    host.handle({ type: 'chat-attach', chat: 'b' });
    host.handle({ type: 'chat-attach', chat: 'a' });
    expect(chats).toHaveLength(2);
    expect(sent.filter((event) => event.type === 'chat' && event.event.type === 'ready').map((event) => (event as { chat: string }).chat)).toEqual(['a', 'b']);
    host.handle({ type: 'chat', chat: 'b', request: { type: 'send', text: 'to b', id: '1' } });
    host.handle({ type: 'chat', chat: 'a', request: { type: 'send', text: 'to a', id: '2' } });
    host.handle({ type: 'chat', chat: 'nobody', request: { type: 'send', text: 'lost', id: '3' } });
    await settle();
    expect(chats[0]!.handled.map((request) => request.type)).toEqual(['send']);
    expect(chats[1]!.handled.map((request) => request.type)).toEqual(['send']);
    const outputs = sent.flatMap((event) => event.type === 'chat' && event.event.type === 'output' ? [[event.chat, event.event.payload.text]] : []);
    expect(outputs.sort()).toEqual([['a', 'to a'], ['b', 'to b']]);
    // Code running for no chat reaches none.
    expect(host.routed.sendRouted({ type: 'notice', message: 'x', level: 'info' })).toBe(false);
  });

  it('keeps a chat\'s quiet choices quiet, but not its errors', async () => {
    const { host, sent, chats } = setup();
    host.handle({ type: 'chat-attach', chat: 'a' });
    chats[0]!.quietOutput = 1;
    host.handle({ type: 'chat', chat: 'a', request: { type: 'send', text: 'quiet', id: '1' } });
    await settle();
    expect(sent.some((event) => event.type === 'chat' && event.event.type === 'output')).toBe(false);
  });

  it('closes one chat alone, and every chat on shutdown, once', async () => {
    const { host, sent, chats } = setup();
    host.handle({ type: 'chat-attach', chat: 'a' });
    host.handle({ type: 'chat-attach', chat: 'b' });
    host.handle({ type: 'chat', chat: 'a', request: { type: 'close' } });
    host.handle({ type: 'chat', chat: 'a', request: { type: 'close' } });
    await settle();
    expect(chats[0]!.shutdowns).toBe(1);
    expect(chats[1]!.shutdowns).toBe(0);
    expect(sent.filter((event) => event.type === 'chat-closed')).toEqual([{ type: 'chat-closed', chat: 'a' }]);
    expect(host.size).toBe(1);
    host.handle({ type: 'chat', chat: 'a', request: { type: 'send', text: 'gone', id: '1' } });
    expect(chats[0]!.handled).toHaveLength(0);
    await Promise.all([host.shutdown(), host.shutdown()]);
    expect(chats[1]!.shutdowns).toBe(1);
    expect(host.size).toBe(0);
    // Nothing new joins a process that is going.
    host.handle({ type: 'chat-attach', chat: 'c' });
    expect(chats).toHaveLength(2);
  });

  it('tells each chat what the others show, never itself', () => {
    const { host, chats } = setup();
    host.handle({ type: 'chat-attach', chat: 'a' });
    host.handle({ type: 'chat-attach', chat: 'b' });
    chats[0]!.conversation = 's1';
    chats[1]!.conversation = 's2';
    expect([...chats[0]!.siblings.showingElsewhere(chats[0] as never)]).toEqual(['s2']);
    expect([...chats[1]!.siblings.showingElsewhere(chats[1] as never)]).toEqual(['s1']);
  });
});

describe('a chat leaving a conversation a sibling still shows', () => {
  it('keeps the process\'s presence and the sibling\'s local model, and leaves when the last one goes', async () => {
    const { IdeBridge } = await import('./bridge.js');
    const { leaveConversation } = await import('../session/attach.js');
    const { reconcileLocalModelLeases } = await import('../commands/ai/local-model.js');
    let others = new Set(['shared']);
    const siblings: BridgeSiblings = { showingElsewhere: () => others };
    const first = new IdeBridge({} as Conf, { send: () => undefined }, siblings);
    (first as unknown as { sessionId: string }).sessionId = 'shared';
    await first.shutdown();
    expect(leaveConversation).not.toHaveBeenCalled();
    expect(reconcileLocalModelLeases).toHaveBeenLastCalledWith(undefined, others);
    others = new Set();
    const last = new IdeBridge({} as Conf, { send: () => undefined }, siblings);
    (last as unknown as { sessionId: string }).sessionId = 'shared';
    await last.shutdown();
    expect(leaveConversation).toHaveBeenCalledWith('shared');
  });
});

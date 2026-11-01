/** The conversation is sent whole once, then only what the editor lacks. */
import { describe, expect, it } from 'vitest';
import type Conf from 'conf';
import type { HarnessSession } from '../session/model.js';
import type { WorkerEvent } from '../worker/protocol.js';
import { IdeBridge } from './bridge.js';
import type { IdeEvent, IdeFeature } from './protocol.js';
import { SessionDeltaReceiver, SessionDeltaSender } from './session-delta.js';

type Message = NonNullable<HarnessSession['messages']>[number];
const said = (count: number, from = 0): Message[] => Array.from({ length: count }, (_, index) => ({
  role: (index + from) % 2 ? 'assistant' : 'user', content: `message ${index + from} ${'x'.repeat(200)}`,
}) as Message);
const chat = (messages: Message[] | undefined, fields: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', name: 'Chat', route: 'local', nativeHarness: 'claude', ...(messages ? { messages } : {}), ...fields,
} as HarnessSession);
const session = (value: HarnessSession): IdeEvent => ({ type: 'session', session: value });
const snapshot = (value: HarnessSession, live = false): IdeEvent => ({
  type: 'worker', sessionId: value.id, event: { type: 'snapshot', session: value, ...(live ? { live: { prompt: 'p' } } : {}) } as WorkerEvent,
});
const carried = (event: IdeEvent): HarnessSession => (event.type === 'session' ? event.session : (event as { event: { session: HarnessSession } }).event.session);
const from = (event: IdeEvent): number | undefined => (event as { messagesFrom?: number }).messagesFrom;

describe('the bridge\'s half', () => {
  it('sends the conversation whole first, then only the messages added, and none for a settings change', () => {
    const sender = new SessionDeltaSender();
    const first = sender.slim(session(chat(said(100))));
    expect(from(first)).toBeUndefined();
    expect(carried(first).messages).toHaveLength(100);
    // A setting changed: the session without its messages.
    const setting = sender.slim(session(chat(said(100), { model: 'opus' })));
    expect(from(setting)).toBe(100);
    expect(carried(setting).messages).toEqual([]);
    expect(carried(setting).model).toBe('opus');
    // A turn ended: its two messages.
    const turn = sender.slim(snapshot(chat(said(102))));
    expect(from(turn)).toBe(100);
    expect(carried(turn).messages).toEqual(said(2, 100));
    expect(JSON.stringify(turn).length).toBeLessThan(JSON.stringify(first).length / 20);
  });

  it('sends it whole again after anything but an append, another chat, or an open', () => {
    const sender = new SessionDeltaSender();
    sender.slim(session(chat(said(10))));
    // /undo: shorter.
    expect(from(sender.slim(session(chat(said(8)))))).toBeUndefined();
    // Rewritten in place: the last held message differs.
    const rewritten = said(8);
    rewritten[7] = { ...rewritten[7]!, content: 'compacted' };
    expect(from(sender.slim(session(chat([...rewritten, ...said(2, 8)]))))).toBeUndefined();
    // The first message differs (a fold rewrote the start), however long.
    const folded = said(12);
    folded[0] = { ...folded[0]!, content: 'summary' };
    expect(from(sender.slim(session(chat(folded))))).toBeUndefined();
    expect(from(sender.slim(session(chat(folded))))).toBe(12);
    // Another chat.
    expect(from(sender.slim(session(chat(said(12), { id: 's2' }))))).toBeUndefined();
    // Opened again.
    sender.reset();
    expect(from(sender.slim(session(chat(said(12), { id: 's2' }))))).toBeUndefined();
  });

  it('leaves events without a conversation alone, and a session with no messages field is not a base', () => {
    const sender = new SessionDeltaSender();
    const notice: IdeEvent = { type: 'notice', message: 'hi', level: 'info' };
    expect(sender.slim(notice)).toBe(notice);
    sender.slim(session(chat(said(4))));
    const bare = session(chat(undefined));
    expect(sender.slim(bare)).toBe(bare);
    expect(from(sender.slim(session(chat(said(4)))))).toBeUndefined();
  });
});

describe('the client\'s half', () => {
  it('rebuilds every event whole, whatever order sessions and snapshots come in', () => {
    const sender = new SessionDeltaSender();
    const receiver = new SessionDeltaReceiver();
    const shown: HarnessSession[] = [];
    const sent = (event: IdeEvent): void => { shown.push(carried(receiver.expand(JSON.parse(JSON.stringify(sender.slim(event))) as IdeEvent))); };
    let messages = said(30);
    sent(session(chat(messages)));
    for (let turn = 0; turn < 6; turn += 1) {
      sent(session(chat(messages, { model: `m${turn}` })));
      sent(snapshot(chat(messages), true));
      messages = [...messages, ...said(2, messages.length)];
      sent(snapshot(chat(messages)));
      sent(session(chat(messages)));
    }
    // A rewrite: whole again, and appended to after.
    messages = said(5);
    sent(session(chat(messages)));
    messages = [...messages, ...said(1, 5)];
    sent(session(chat(messages, { name: 'Renamed' })));
    for (const value of shown.slice(0, -2)) expect(value.messages!.length).toBeGreaterThanOrEqual(30);
    expect(shown.at(-1)!.messages).toEqual(said(6));
    expect(shown.at(-1)!.name).toBe('Renamed');
    expect(shown[shown.length - 4]!.messages).toEqual(said(42));
    expect(shown.every((value) => !('messagesFrom' in value))).toBe(true);
  });

  it('hands out its own copy: a consumer that changes it does not change what is held', () => {
    const receiver = new SessionDeltaReceiver();
    const whole = carried(receiver.expand(session(chat(said(3)))));
    whole.messages!.push(said(1, 99)[0]!);
    const next = receiver.expand({ ...session(chat(said(1, 3))), messagesFrom: 3 } as IdeEvent);
    expect(carried(next).messages).toEqual(said(4));
  });
});

describe('the bridge sends it so to an editor that asks', () => {
  const bridgeWith = (features: IdeFeature[]) => {
    const sent: IdeEvent[] = [];
    const bridge = new IdeBridge({} as Conf, { send: (event) => sent.push(event) });
    const inner = bridge as unknown as { features: ReadonlySet<IdeFeature>; channel: { send(event: IdeEvent): void } };
    inner.features = new Set(features);
    return { sent, send: (event: IdeEvent) => inner.channel.send(event), bridge };
  };

  it('with `session-delta`: whole, then the tail; a worker snapshot relayed too; whole again after an open', () => {
    const { sent, send, bridge } = bridgeWith(['session-delta']);
    send(session(chat(said(50))));
    send(snapshot(chat(said(50)), true));
    send(snapshot(chat(said(52))));
    expect(sent.map(from)).toEqual([undefined, 50, 50]);
    expect(carried(sent[2]!).messages).toEqual(said(2, 50));
    // An open names the features again, and is sent the conversation whole.
    bridge.handle({ type: 'open', requestId: 'r', mode: 'resume', sessionId: 'missing', features: ['session-delta'] } as never);
    send(session(chat(said(52))));
    expect(from(sent.at(-1)!)).toBeUndefined();
    void bridge.shutdown();
  });

  it('without it: every event whole, as before', () => {
    const { sent, send } = bridgeWith([]);
    send(session(chat(said(50))));
    send(snapshot(chat(said(52))));
    expect(sent.map(from)).toEqual([undefined, undefined]);
    expect(carried(sent[1]!).messages).toHaveLength(52);
  });
});

describe('coming back to a chat', () => {
  const longChat = (count: number): Message[] => said(count);

  it('sends only what follows the copy a client kept, when it is the start of the chat', () => {
    const kept = longChat(100);
    const receiver = new SessionDeltaReceiver();
    receiver.preload('s1', kept);
    const sender = new SessionDeltaSender();
    sender.adopt(receiver.claim('s1')!);
    const event = sender.slim(session(chat(longChat(104))));
    expect(from(event)).toBe(100);
    expect(carried(event).messages).toEqual(said(4, 100));
    expect(carried(receiver.expand(event)).messages).toEqual(longChat(104));
  });

  it('sends the chat whole when the copy is not the start of it, or is more than there is', () => {
    const receiver = new SessionDeltaReceiver();
    receiver.preload('s1', longChat(50));
    const claim = receiver.claim('s1')!;
    const edited = longChat(60);
    edited[49] = { role: 'assistant', content: 'rewritten' } as Message;
    const sender = new SessionDeltaSender();
    sender.adopt(claim);
    expect(from(sender.slim(session(chat(edited))))).toBeUndefined();
    sender.adopt(claim);
    expect(from(sender.slim(session(chat(longChat(10)))))).toBeUndefined();
    sender.adopt(claim);
    expect(from(sender.slim(session(chat(longChat(60), { id: 's2' }))))).toBeUndefined();
  });

  it('holds nothing of a chat it was never sent, and a whole answer replaces what was kept', () => {
    const receiver = new SessionDeltaReceiver();
    expect(receiver.claim('s1')).toBeUndefined();
    receiver.preload('s1', longChat(5), 'gen-a');
    expect(receiver.claim('s1')?.gen).toBe('gen-a');
    receiver.expand(session(chat(longChat(8))));
    expect(receiver.claim('s1')?.count).toBe(8);
    expect(receiver.claim('s1')?.gen).toBeUndefined();
    receiver.generation('s1', 'gen-b');
    expect(receiver.claim('s1')?.gen).toBe('gen-b');
  });

  it('cuts the older messages\' tool calls down, keeps their count, and reads the same either way', async () => {
    const { wireMessage, WHOLE_MESSAGES, PREVIEW_MESSAGES } = await import('./session-wire.js');
    const call = (index: number) => ({ responseOffset: 0, event: { kind: 'tool-done', label: `Bash(${index})`, id: `c${index}`, call: { name: 'Bash', input: { command: 'x'.repeat(5000) } }, output: Array.from({ length: 60 }, (_, line) => `line ${line}`) } });
    const big = (index: number): Message => ({ role: 'assistant', content: `reply ${index}`, activities: [call(index), call(index + 1)] }) as unknown as Message;
    const messages = Array.from({ length: 80 }, (_, index) => big(index));
    const sent = new SessionDeltaSender(wireMessage).slim(session(chat(messages)));
    const got = carried(sent).messages!;
    expect(got[79]).toEqual(messages[79]);
    expect(got[80 - WHOLE_MESSAGES]).toEqual(messages[80 - WHOLE_MESSAGES]);
    const preview = got[80 - WHOLE_MESSAGES - 1]!.activities![0]!.event;
    expect(preview.call).toBeUndefined();
    expect(preview.output!.length).toBeLessThan(60);
    expect(preview.output!.length).toBeGreaterThan(0);
    const bare = got[80 - PREVIEW_MESSAGES - 1]!.activities![0]!.event;
    expect(bare.output ?? []).toEqual([]);
    expect(bare.label).toBe('Bash(31)');
    for (const [index, message] of got.entries()) {
      expect(message.content).toBe(messages[index]!.content);
      expect(message.activities).toHaveLength(2);
    }
    expect(JSON.stringify(sent).length).toBeLessThan(JSON.stringify(session(chat(messages))).length / 3);
    // What the client holds claims the same as the machine's own messages: it adopts.
    const receiver = new SessionDeltaReceiver();
    receiver.expand(sent);
    const again = new SessionDeltaSender(wireMessage);
    again.adopt(receiver.claim('s1')!);
    expect(from(again.slim(session(chat([...messages, big(80)]))))).toBe(80);
  });
});

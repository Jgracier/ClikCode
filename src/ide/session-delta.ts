/** Small `session` events after the first (the `session-delta` feature).
 *
 * The bridge used to send the whole conversation -- every message -- with
 * each `session` event and each worker `snapshot` it relayed: before a turn,
 * as it started, as it ended and after. Over a pipe that is cheap; over SSH
 * to another machine a long chat is megabytes, and the turn's own events
 * queued behind them (a typed prompt drawn seconds late).
 *
 * A client that names `session-delta` in `open` is sent the conversation
 * whole once (on open, on a switch to another chat, after anything that was
 * not an append), and from then on only what it lacks: the event carries
 * `messagesFrom: n`, and `session.messages` holds just the messages from
 * index n on (none, for a change of settings or name). The client keeps its
 * first n and appends those. Both ends run in order over one channel, so
 * what the bridge last sent IS what the client holds.
 *
 * A client that kept the conversation from last time says what it holds in
 * `open` (`held`, from `claimOf`): the bridge checks it against the chat and,
 * when it is the start of this one, sends only the messages after it -- coming
 * back to a chat is what changed since, not the chat again.
 *
 * Imports nothing at run time: the VS Code extension bundles this file. */
import type { HarnessSession } from '../session/model.js';
import type { IdeEvent } from './protocol.js';

type Messages = NonNullable<HarnessSession['messages']>;

/** The session an event carries the conversation in: a `session`, or a worker `snapshot` relayed. */
function sessionOf(event: IdeEvent): HarnessSession | undefined {
  if (event.type === 'session') return event.session;
  if (event.type === 'worker' && event.event.type === 'snapshot') return event.event.session;
  return undefined;
}

/** `event` with `session` in place of the one it carried, and `messagesFrom` set or removed. */
function withSession(event: IdeEvent, session: HarnessSession, messagesFrom: number | undefined): IdeEvent {
  const { messagesFrom: _dropped, ...rest } = event as IdeEvent & { messagesFrom?: number };
  const from = messagesFrom === undefined ? {} : { messagesFrom };
  if (rest.type === 'session') return { ...rest, session, ...from };
  if (rest.type === 'worker' && rest.event.type === 'snapshot') return { ...rest, event: { ...rest.event, session }, ...from };
  return event;
}

/** A cheap fingerprint of one message (cyrb53 over its JSON). The detail of
 * its tool calls is not in it, only how many there were: a client holds older
 * messages with that detail cut down (`shape`), and the same message must
 * read the same either way. */
function fingerprint(message: Messages[number] | undefined): string {
  if (message === undefined) return '';
  const { activities, ...rest } = message;
  const text = JSON.stringify(activities?.length ? { ...rest, calls: activities.length } : rest);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}:${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

/** What a client holds of a chat: how many messages, and the first's and last's fingerprints. */
export interface HeldChat {
  sessionId: string; count: number; first: string; last: string;
  /** The generation of the chat's log there (session/store/chat-log.ts): new whenever the log is rewritten,
   * which an append is not. The client's copy is the start of the chat only while it is the same. */
  gen?: string;
}

/** What `messages` of chat `sessionId` come to, for an `open` to say what the client already has. */
export function claimOf(sessionId: string, messages: Messages, gen?: string): HeldChat | undefined {
  if (!messages.length) return undefined;
  return { sessionId, count: messages.length, first: fingerprint(messages[0]), last: fingerprint(messages[messages.length - 1]), ...(gen ? { gen } : {}) };
}

/** A message as the client is sent it, by how many messages come after it (0: the newest). */
export type MessageShape = (message: Messages[number], after: number) => Messages[number];

/** The bridge's half: what the client holds of the chat, and the events cut to what it lacks. */
export class SessionDeltaSender {
  private held: HeldChat | undefined;

  constructor(private readonly shape: MessageShape = (message) => message) {}

  /** The client holds nothing (an `open`): the next event is whole. */
  reset(): void { this.held = undefined; }

  /** The client says it holds the start of this chat (an `open`'s `held`):
   * the next event is checked against it, and is only what follows when it
   * is, whole when it is not. */
  adopt(held: HeldChat): void { this.held = held; }

  private shaped(messages: Messages, from: number): Messages {
    return messages.slice(from).map((message, index) => this.shape(message, messages.length - 1 - (from + index)));
  }

  /** `event` as this client needs it: whole the first time and after any
   * change that was not an append, its new messages only otherwise. Events
   * that carry no conversation pass as they are. */
  slim(event: IdeEvent): IdeEvent {
    const session = sessionOf(event);
    if (!session) return event;
    const messages = session.messages;
    // No messages field at all: sent as it is, and the next one whole.
    if (!messages) { this.held = undefined; return event; }
    const held = this.held;
    const appended = held !== undefined && held.sessionId === session.id && messages.length >= held.count
      && (held.count === 0 || (fingerprint(messages[0]) === held.first && fingerprint(messages[held.count - 1]) === held.last));
    this.held = {
      sessionId: session.id, count: messages.length,
      first: fingerprint(messages[0]), last: fingerprint(messages[messages.length - 1]),
    };
    if (!appended) return withSession(event, { ...session, messages: this.shaped(messages, 0) }, undefined);
    return withSession(event, { ...session, messages: this.shaped(messages, held.count) }, held.count);
  }
}

/** The client's half: the conversation as last sent whole or appended to,
 * and each event made whole again -- the shape every event had before. */
export class SessionDeltaReceiver {
  private held: { sessionId: string; messages: Messages; gen?: string } | undefined;

  /** The conversation kept from last time: what the next `open` says it holds. */
  preload(sessionId: string, messages: Messages, gen?: string): void { this.held = { sessionId, messages: [...messages], ...(gen ? { gen } : {}) }; }

  /** The log generation the machine said for the chat held (an `open`'s answer). */
  generation(sessionId: string, gen: string | undefined): void {
    if (this.held?.sessionId === sessionId) this.held = { sessionId, messages: this.held.messages, ...(gen ? { gen } : {}) };
  }

  /** What is held now, to keep for next time. */
  current(): { sessionId: string; messages: Messages; gen?: string } | undefined { return this.held; }

  /** What an `open` of `sessionId` says this client holds of it. */
  claim(sessionId: string): HeldChat | undefined {
    return this.held?.sessionId === sessionId ? claimOf(sessionId, this.held.messages, this.held.gen) : undefined;
  }

  expand(event: IdeEvent): IdeEvent {
    const session = sessionOf(event);
    if (!session) return event;
    const from = (event as { messagesFrom?: number }).messagesFrom;
    if (from === undefined) {
      // Whole: nothing of what was held is kept, its generation with it (the `open`'s answer says the new one).
      this.held = session.messages ? { sessionId: session.id, messages: [...session.messages] } : undefined;
      return event;
    }
    // The bridge sends a delta only on top of what it sent this client last;
    // a client holding anything else is a bug, and the tail alone is the most
    // it can show.
    const same = this.held?.sessionId === session.id ? this.held : undefined;
    const messages = [...(same?.messages ?? []).slice(0, from), ...(session.messages ?? [])];
    this.held = { sessionId: session.id, messages, ...(same?.gen ? { gen: same.gen } : {}) };
    return withSession(event, { ...session, messages: [...messages] }, undefined);
  }
}

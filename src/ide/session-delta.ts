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

/** A cheap fingerprint of one message (cyrb53 over its JSON). */
function fingerprint(message: Messages[number] | undefined): string {
  if (message === undefined) return '';
  const text = JSON.stringify(message);
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

/** The bridge's half: what the client holds of the chat, and the events cut to what it lacks. */
export class SessionDeltaSender {
  private held: { sessionId: string; count: number; first: string; last: string } | undefined;

  /** The client holds nothing (an `open`): the next event is whole. */
  reset(): void { this.held = undefined; }

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
    if (!appended) return event;
    return withSession(event, { ...session, messages: messages.slice(held.count) }, held.count);
  }
}

/** The client's half: the conversation as last sent whole or appended to,
 * and each event made whole again -- the shape every event had before. */
export class SessionDeltaReceiver {
  private held: { sessionId: string; messages: Messages } | undefined;

  expand(event: IdeEvent): IdeEvent {
    const session = sessionOf(event);
    if (!session) return event;
    const from = (event as { messagesFrom?: number }).messagesFrom;
    if (from === undefined) {
      this.held = session.messages ? { sessionId: session.id, messages: [...session.messages] } : undefined;
      return event;
    }
    // The bridge sends a delta only on top of what it sent this client last;
    // a client holding anything else is a bug, and the tail alone is the most
    // it can show.
    const held = this.held?.sessionId === session.id ? this.held.messages : [];
    const messages = [...held.slice(0, from), ...(session.messages ?? [])];
    this.held = { sessionId: session.id, messages };
    return withSession(event, { ...session, messages: [...messages] }, undefined);
  }
}

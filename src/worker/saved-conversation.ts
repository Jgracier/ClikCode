/** A window's half of a slim snapshot (broadcast-observer.ts windowReadsSaved):
 * the saved messages, read from the one place they live.
 *
 * The worker's own copy came from this same log, so nothing is lost by not
 * sending it -- and what a switch costs no longer depends on how long the
 * conversation is. */

import { readSessionTranscript, readTranscriptAt } from '../session/store/transcripts.js';
import { cloneData } from '../session/store/data.js';
import type { WorkerEvent } from './protocol.js';

type Snapshot = Extract<WorkerEvent, { type: 'snapshot' }>;
type Messages = NonNullable<Snapshot['session']['messages']>;

/** The messages the snapshot describes: exactly the first `end` of the log of
 * generation `gen` (the log only grows within a generation, so these are the
 * very messages the worker held). Matching by count alone took the wrong ones
 * after a rewind and a new turn -- as many messages, not the same. Undefined
 * when the log was rewritten since (a rewind, a fold): that history is gone.
 * A worker that names no generation (an older build) is read by count. */
async function savedMessages(sessionId: string, saved: NonNullable<Snapshot['saved']>): Promise<Messages | undefined> {
  if (saved.gen !== undefined && saved.end !== undefined) {
    const exact = await readTranscriptAt(sessionId, { gen: saved.gen, end: saved.end });
    return exact && cloneData(exact);
  }
  const messages = (await readSessionTranscript(sessionId)).messages ?? [];
  // The stored history itself (frozen): the window gets its own copy.
  return cloneData(messages.length > saved.count ? messages.slice(0, saved.count) : messages);
}

/** The snapshot a window's consumers expect: whole. One that arrived whole
 * (an older worker, or a conversation with no messages) is returned as it is.
 *
 * One whose history was rewritten before the window read it describes a
 * conversation that no longer exists: the window is given the stored one, and
 * no live turn -- a turn running before a rewind had ended before it, and
 * drawn over the rewritten history it would continue the wrong messages. The
 * rewrite brings the worker's next snapshot, which is current. */
export async function withSavedConversation(event: Snapshot): Promise<Snapshot> {
  if (!event.saved) return event;
  const { saved, live: _live, ...rest } = event;
  const messages = await savedMessages(event.session.id, saved);
  if (messages) return { ...rest, ...(event.live ? { live: event.live } : {}), session: { ...event.session, messages } };
  return { ...rest, session: { ...event.session, messages: cloneData((await readSessionTranscript(event.session.id)).messages ?? []) } };
}

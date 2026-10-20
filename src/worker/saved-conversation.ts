/** A window's half of a slim snapshot (broadcast-observer.ts windowReadsSaved):
 * the saved messages, read from the one place they live.
 *
 * The worker's own copy came from this same read (worker-io.ts), so nothing
 * is lost by not sending it -- and what a switch costs no longer depends on
 * how long the conversation is. */

import { readSessionTranscript } from '../session/store/transcripts.js';
import type { WorkerEvent } from './protocol.js';

type Snapshot = Extract<WorkerEvent, { type: 'snapshot' }>;

/** A transcript shorter than the worker saw is a write caught half way (a
 * rewind or a fold rewrites it); it is read again before it is believed. */
const READ_AGAIN_MS = 25;
const READ_AGAIN_TIMES = 4;

/** The first `count` saved messages: the conversation as the snapshot's live
 * state describes it. The file may already be ahead (a turn finished since the
 * worker looked); the messages after `count` belong to the snapshot that
 * follows, and drawn now they would sit beside the live turn that wrote them. */
async function savedMessages(sessionId: string, count: number): Promise<NonNullable<Snapshot['session']['messages']>> {
  let messages = (await readSessionTranscript(sessionId)).messages ?? [];
  for (let again = 0; messages.length < count && again < READ_AGAIN_TIMES; again += 1) {
    await new Promise((resolve) => setTimeout(resolve, READ_AGAIN_MS));
    messages = (await readSessionTranscript(sessionId)).messages ?? [];
  }
  return messages.length > count ? messages.slice(0, count) : messages;
}

/** The snapshot a window's consumers expect: whole. One that arrived whole
 * (an older worker, or a conversation with no messages) is returned as it is. */
export async function withSavedConversation(event: Snapshot): Promise<Snapshot> {
  if (!event.saved) return event;
  const { saved, ...rest } = event;
  return { ...rest, session: { ...event.session, messages: await savedMessages(event.session.id, saved.count) } };
}

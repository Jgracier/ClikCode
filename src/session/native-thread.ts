/** The vendor's own thread for a conversation is a disposable optimization:
 * session.messages is the durable, vendor-agnostic record. Forgetting it --
 * a new account, harness, workspace or option that needs a fresh thread, or a
 * thread the vendor no longer knows -- clears every field that describes it,
 * so the next turn starts fresh and carries the conversation in its prompt.
 * Its id is remembered in `ownedThreads`. */
import type { HarnessSession } from './model.js';
import { messageOrigin, sessionTranscriptMessages } from '../turn/checkpoint.js';

export function forgetNativeThread(session: HarnessSession): void {
  // Still ClikCode's: kept so discovery never offers it back as a vendor chat.
  const thread = session.nativeSessionId && session.nativeHarness ? `${session.nativeHarness}:${session.nativeSessionId}` : undefined;
  if (thread && !session.ownedThreads?.includes(thread)) session.ownedThreads = [...session.ownedThreads ?? [], thread];
  session.nativeSessionId = undefined;
  delete session.nativeTransport;
  session.nativeStartedAt = undefined;
  delete session.nativeSessionPreallocated;
}

/** What a conversation sheds when another provider takes it up in place.
 * Every message so far keeps whose it was (an unstamped one is the provider
 * leaving's), a turn left in the journal becomes history for the next
 * provider to continue, and everything that described the old provider's
 * thread goes: the next turn starts the new one from the record
 * (turn/thread-start.ts). */
export function leaveProvider(session: HarnessSession): void {
  const origin = messageOrigin(session);
  session.messages = sessionTranscriptMessages(session).map((message) => (message.origin ? message : { ...message, origin }));
  delete session.pendingTurn;
  forgetNativeThread(session);
  for (const key of ['reported', 'effortRefused', 'lastUsage', 'resumeAt', 'harnessOptions', 'gatewayConfirmed'] as const) delete session[key];
  session.updatedAt = new Date().toISOString();
}

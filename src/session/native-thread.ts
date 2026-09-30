/** The vendor's own thread for a conversation is a disposable optimization:
 * session.messages is the durable, vendor-agnostic record. Forgetting it --
 * a new account, harness, workspace or option that needs a fresh thread, or a
 * thread the vendor no longer knows -- clears every field that describes it,
 * so the next turn starts fresh and carries the conversation in its prompt. */
import type { HarnessSession } from './model.js';

export function forgetNativeThread(session: HarnessSession): void {
  session.nativeSessionId = undefined;
  delete session.nativeTransport;
  session.nativeStartedAt = undefined;
  delete session.nativeSessionPreallocated;
}

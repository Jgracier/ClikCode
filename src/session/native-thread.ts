/** The vendor's own thread for a conversation is a disposable optimization:
 * session.messages is the durable, vendor-agnostic record. Forgetting it --
 * a new account, harness, workspace or option that needs a fresh thread, or a
 * thread the vendor no longer knows -- clears every field that describes it,
 * so the next turn starts fresh and carries the conversation in its prompt.
 * Its id is remembered in `ownedThreads`. */
import { createHash } from 'node:crypto';
import type { HarnessSession, TranscriptMessage } from './model.js';
import { messageOrigin, sessionTranscriptMessages } from '../turn/checkpoint.js';
import { readsVendorCompaction } from './conversation-summary.js';

export function forgetNativeThread(session: HarnessSession): void {
  // Still ClikCode's: kept so discovery never offers it back as a vendor chat.
  const thread = session.nativeSessionId && session.nativeHarness ? `${session.nativeHarness}:${session.nativeSessionId}` : undefined;
  if (thread && !session.ownedThreads?.includes(thread)) session.ownedThreads = [...session.ownedThreads ?? [], thread];
  if (session.nativeHarness && session.nativeThreads) delete session.nativeThreads[session.nativeHarness];
  clearActiveNativeThread(session);
}

function clearActiveNativeThread(session: HarnessSession): void {
  session.nativeSessionId = undefined;
  delete session.nativeThreadAccountId;
  delete session.nativeTransport;
  session.nativeStartedAt = undefined;
  delete session.nativeSessionPreallocated;
}

function transcriptAnchor(messages: readonly TranscriptMessage[], through: number): string {
  const hash = createHash('sha256');
  for (let index = 0; index < through; index += 1) hash.update(JSON.stringify(messages[index]));
  return hash.digest('hex');
}

/** Park a confirmed vendor thread for a later return to this harness. A
 * preallocated id has never existed at the vendor, so it cannot be resumed. */
export function parkNativeThread(session: HarnessSession): void {
  const harness = session.nativeHarness;
  const id = session.nativeSessionId;
  if (harness && id && !session.nativeSessionPreallocated) {
    const messages = session.messages ?? [];
    session.nativeThreads = {
      ...session.nativeThreads,
      [harness]: {
        id,
        ...(session.nativeThreadAccountId ? { accountId: session.nativeThreadAccountId } : {}),
        ...(session.nativeTransport ? { transport: session.nativeTransport } : {}),
        ...(session.workspace ? { workspace: session.workspace } : {}),
        through: messages.length,
        anchor: transcriptAnchor(messages, messages.length),
      },
    };
    const owned = `${harness}:${id}`;
    if (!session.ownedThreads?.includes(owned)) session.ownedThreads = [...session.ownedThreads ?? [], owned];
  }
  clearActiveNativeThread(session);
}

/** Restore only a thread whose saved prefix still matches this conversation.
 * Edits, forks and workspace moves cannot silently resume stale history. */
export function restoreNativeThread(session: HarnessSession, harness: string): number | undefined {
  if (session.nativeSessionId) return undefined;
  const slot = session.nativeThreads?.[harness];
  if (!slot) return undefined;
  const messages = session.messages ?? [];
  if (slot.workspace !== session.workspace || slot.through > messages.length
    || slot.anchor !== transcriptAnchor(messages, slot.through)) {
    delete session.nativeThreads![harness];
    return undefined;
  }
  delete session.nativeThreads![harness];
  session.nativeSessionId = slot.id;
  session.nativeThreadAccountId = slot.accountId;
  session.nativeTransport = slot.transport;
  return slot.through;
}

/** What a conversation sheds when another provider takes it up in place.
 * Every message so far keeps whose it was (an unstamped one is the provider
 * leaving's), a turn left in the journal becomes history for the next
 * provider to continue. Its native thread is parked for a later return. */
export function leaveProvider(session: HarnessSession): void {
  const origin = messageOrigin(session);
  session.messages = sessionTranscriptMessages(session).map((message) => (message.origin ? message : { ...message, origin }));
  delete session.pendingTurn;
  // A vendor whose compactions ClikCode can read: where its thread is, so the
  // next provider can be handed the summary it wrote (conversation-summary.ts).
  if (session.nativeHarness && session.nativeSessionId && readsVendorCompaction(session.nativeHarness)) {
    const accountId = session.nativeThreadAccountId ?? session.accountId ?? undefined;
    session.previousNativeThread = {
      harness: session.nativeHarness, id: session.nativeSessionId,
      ...(accountId ? { accountId } : {}), ...(session.workspace ? { workspace: session.workspace } : {}),
    };
  }
  parkNativeThread(session);
  for (const key of ['reported', 'lastUsage', 'resumeAt', 'harnessOptions', 'gatewayConfirmed'] as const) delete session[key];
  session.updatedAt = new Date().toISOString();
}

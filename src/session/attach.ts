/**
 * A client attached to one conversation: the terminal loop
 * (commands/ai/interactive.ts) and the editor bridge (ide/bridge.ts) are both
 * this, with different screens. What they decide the same way lives here, so
 * the two cannot drift: the claim saying which client has the chat open, and
 * what leaving it does.
 *
 * The claim is bookkeeping, never a lock: any number of clients can have a
 * chat open, and its worker serializes their turns (worker/turn-bridge.ts).
 */
import { readState } from './state/read.js';
import { writeState } from './state/write.js';
import { claimSession, releaseSession, sessionClaimIsLive } from './claim.js';
import { discardIfBlank } from './blank.js';

/** This client has the conversation open: taken on open and refreshed on a
 * timer (a third of the TTL). A claim another live client holds is left
 * alone and nothing is written; session/claims.ts would refuse it anyway. */
export async function claimConversation(id: string): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session || sessionClaimIsLive(session)) return;
  claimSession(session);
  await writeState(state);
}

/** Hands the conversation back. Only this process's own claim is released
 * (releaseSession checks it too), and nothing is written when there is none. */
export async function releaseConversationClaim(id: string): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (session?.claim?.pid !== process.pid) return;
  releaseSession(session);
  await writeState(state);
}

/** This client stops showing a conversation: its claim goes, and one that
 * was never started is not kept. The claim first: it reads the record it
 * releases. */
export async function leaveConversation(id: string): Promise<void> {
  await releaseConversationClaim(id).catch(() => undefined);
  await discardIfBlank(id).catch(() => undefined);
}

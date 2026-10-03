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
import { discardIfBlank, ensureSessionOnDisk } from './blank.js';
import { backfillListFacts } from './list-backfill.js';
import { chatNamed, isBlankConversation, latestChat } from './options.js';
import type { HarnessSession, HarnessState } from './model.js';
import { launchSession } from '../commands/ai/sessions.js';
import { sessionOrProviderHarness } from '../tui/slash/context.js';
import { resolveNativeModel } from '../harness/accounts/model-catalog.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { ensureTurboFitForTurn } from '../commands/ai/turbofit.js';
import { ensureLocalModelForTurn } from '../commands/ai/local-model.js';
import { releaseQueuedTurn } from '../commands/ai/conversations.js';
import { isUsageExhaustedMessage } from '../turn/usage-exhausted.js';
import { carryOnAfterExhaustion, type ExhaustionRetryGuard, type ResumedIn } from '../tui/pickers/resume-in.js';
import type { HarnessPrompter } from '../harness/prompter.js';

/** Reopened, a closed or archived chat is active again. */
export function activateSession(session: HarnessSession): boolean {
  if (session.status === 'active') return false;
  session.status = 'active';
  session.closedAt = undefined;
  session.updatedAt = new Date().toISOString();
  return true;
}

/** The conversation a client opens with: a fresh one (`new`, or `continue`
 * with nothing to continue), the latest one, or the one `ref` names -- an id,
 * the start of one, a chat's name, or `last`. `sameWorkspace` limits
 * `continue` to unarchived chats of this workspace (the editor's); otherwise
 * it prefers this workspace's and falls back to any.
 *
 * Chats that predate the row summary are summarized in the background: waiting
 * made the first open after an upgrade pay for every transcript. */
export async function openConversation(
  workspace: string, mode: 'new' | 'continue' | 'resume', ref?: string, options: { sameWorkspace?: boolean } = {},
): Promise<string> {
  const state = await readState({ transcripts: [] });
  if (state.sessions.some((session) => !session.listChecked && !isBlankConversation(session))) {
    void backfillListFacts().catch(() => undefined);
  }
  let session: HarnessSession | undefined;
  if (mode === 'resume') {
    if (!ref) throw new Error('resume needs a conversation id');
    const id = state.sessions.some((item) => item.id === ref) ? ref : chatNamed(state.sessions, ref, '');
    session = id ? state.sessions.find((item) => item.id === id) : undefined;
    if (!session) throw new Error(`no chat matches "${ref}" -- use its name, the start of its id, or last`);
  } else if (mode === 'continue') {
    const candidates = options.sameWorkspace
      ? state.sessions.filter((item) => item.status !== 'archived' && item.workspace === workspace)
      : state.sessions;
    session = latestChat(candidates, workspace);
  }
  if (session) {
    if (activateSession(session)) await writeState(state);
    return session.id;
  }
  // Empty chats are not conversations: the one this opens is not stored
  // until something happens in it, and earlier ones left behind go now.
  state.sessions = state.sessions.filter((item) => !isBlankConversation(item));
  const fresh = launchSession(state, workspace);
  state.sessions.push(fresh);
  await writeState(state);
  return fresh.id;
}

/** A chat with no model gets its harness's default, when the harness
 * publishes one. Failing to find out is not a reason to refuse the chat:
 * the model picker asks later. */
export async function resolveSessionModel(id: string): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session || session.model) return;
  const harness = sessionOrProviderHarness(session);
  if (!harness) return;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const resolved = await resolveNativeModel(harness, account).catch(() => undefined);
  if (!resolved) return;
  session.model = resolved;
  session.updatedAt = new Date().toISOString();
  await writeState(state);
}

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

/** What a turn needs before the worker is handed it, done by the client:
 * the chat is on disk (a draft lives only in this process, and the worker is
 * another one that must read it), and a TurboFit or ClikCode Local model is up
 * -- held by this client, which outlives nothing it shows, not by the worker.
 * `busy` labels the wait, where the client has a line for it. */
export async function prepareTurn(
  targetId: string, busy?: (label?: string) => void,
): Promise<{ state: HarnessState; active: HarnessSession | undefined }> {
  await ensureSessionOnDisk(targetId);
  const state = await readState({ transcripts: [targetId] });
  const active = state.sessions.find((item) => item.id === targetId);
  const harness = active?.nativeHarness ? localHarnessForCommand(active.nativeHarness) : undefined;
  if (active && harness) {
    busy?.('preparing…');
    try {
      await ensureTurboFitForTurn(harness, state.accounts.find((item) => item.id === active.accountId), targetId, active.model);
    } finally { busy?.(); }
  }
  if (active?.route === 'clikcode-local') {
    busy?.('loading the local model…');
    try { await ensureLocalModelForTurn(active); } finally { busy?.(); }
  }
  return { state, active };
}

export function turnWasCancelled(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ERR_TURN_CANCELLED' || (error as Error)?.name === 'AbortError';
}

/** What follows a turn that failed: send it again here, carry it on in the
 * chat "Resume in" moved it to, or hand text back to the composer. */
export type TurnFailureNext = { cancelled: boolean } & ({ retry: string } | { moved: ResumedIn } | { back: string[] });

/** A turn failed -- one this client sent (`line`, and `sent` when a slash
 * command expanded it), one it took from the queue (`queuedTurnId`), or one
 * it was only following.
 *
 * A queued turn that cannot start would stay at the head of the queue and
 * fail identically on every pass, so it is released and its text handed
 * back. Running out of usage is an outcome, not a fault: with a `prompter`
 * to ask, it retries once on this provider if an account came back, and
 * otherwise offers the harnesses that still have some. Carried on, the
 * message is not handed back as well (it would then be sent twice). */
export async function afterTurnFailure(
  prompter: HarnessPrompter | undefined, id: string, error: unknown,
  turn: { line?: string; sent?: string; queuedTurnId?: string; guard: ExhaustionRetryGuard },
): Promise<TurnFailureNext> {
  const cancelled = turnWasCancelled(error);
  const queued = Boolean(turn.queuedTurnId && !cancelled);
  if (queued) await releaseQueuedTurn(id, turn.queuedTurnId!).catch(() => undefined);
  const back = queued && turn.line ? [turn.line] : [];
  const message = error instanceof Error ? error.message : String(error);
  if (cancelled || !prompter || !turn.line || !isUsageExhaustedMessage(message)) return { cancelled, back };
  const next = await carryOnAfterExhaustion(prompter, id, turn.line, turn.guard, turn.sent ?? turn.line);
  if ('stayed' in next) return { cancelled, back: [...back, ...next.stayed] };
  return { cancelled, ...next };
}

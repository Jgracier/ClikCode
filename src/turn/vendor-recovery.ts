/** What a failed vendor attempt does next: a sign-in or a fresh thread retries
 * on the same account (once each); anything else moves the turn to another account. */
import { forgetNativeThread } from '../session/native-thread.js';
import { diagnostic, lifecycle } from '../runtime/lifecycle-log.js';
import { closeStandby, leavePersistentTransport, standbyFor } from './vendor-process.js';
import { moveThreadToAccount } from '../session/carry.js';
import { nativeThreadHoldsConversation } from './native-thread-continuity.js';
import { switchAccountAfterFailure } from './account-switch.js';
import { isModelRefusal, type AccountFailureKind } from './failover.js';
import { recordModelRefusal } from '../harness/accounts/model-refusals.js';
import { resolveNativeModel } from '../harness/accounts/model-catalog.js';
import { nextUsableFailoverAccount, turnBackendForAccount } from './account-routing.js';
import { classifyTurnFailure } from './account-evidence.js';
import { nativeTurnFailure } from '../harness/protocol/turn-result.js';
import { continueAnswer, editAnswer, retell } from './vendor-thread-takeup.js';
import { signInForTurn } from './vendor-sign-in.js';
import type { AttemptRecord } from './vendor-attempt.js';
import type { VendorObserver } from './vendor-observer.js';
import type { VendorTurnContext } from './vendor-turn-context.js';

/** Whether an attempt's streamed text is only the account refusal it then
 * failed with ("You've hit your session limit · resets 3:50pm" streamed as
 * a message, then "Internal error: You've hit your session limit …"). Read
 * only to choose how the next account is set up; what the vendor said is
 * never taken back off the turn. */
export function echoesRefusal(text: string, failure: unknown): boolean {
  const flat = (value: string): string => value.toLowerCase().replace(/^\s*internal error:\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const said = flat(text);
  const refused = flat(failure instanceof Error ? failure.message : String(failure));
  return said.length > 0 && refused.length > 0 && (refused.includes(said) || said.includes(refused));
}

type Failed = AttemptRecord & { failure: Error; failureKind: AccountFailureKind };

/** Reactive counterpart to aiHarnessSelect's proactive login check, which
 * only reads the credential files on disk (harnessNeedsLogin): a credential
 * that is there but expired or revoked first shows as the turn itself
 * erroring out. The account is marked signed out by accounts.after, if
 * signing in here does not fix it. */
async function retryAfterSignIn(ctx: VendorTurnContext, failed: Failed): Promise<boolean> {
  if (!await signInForTurn(ctx, failed.environment)) return false;
  // The failed reply may already be on screen; the retry replaces it.
  editAnswer(ctx, 'clear');
  return true;
}

/** Confirmed live: switching this session to a different account of the same
 * provider used to leave a stale nativeSessionId in place, and resuming it
 * failed with exactly this vendor error. Recovering here means any way a
 * thread id ends up invalid degrades to "start fresh with real context
 * replayed": session.messages is the durable, vendor-agnostic source of
 * truth, and nativeSessionId is a disposable optimization. */
async function retryOnFreshThread(ctx: VendorTurnContext, failed: Failed): Promise<void> {
  ctx.attempt.nativeThreadRetried = true;
  // The one notice of this recovery; the flag above makes it once per attempt.
  diagnostic('vendor.thread-not-resumed', `${ctx.harness.displayName} could not resume its thread; continuing on a new one with the conversation carried over`);
  await leavePersistentTransport(ctx.session.id);
  forgetNativeThread(ctx.session);
  ctx.turnText = await retell(ctx, ctx.askedText, 'clear', Boolean(ctx.session.pendingTurn?.outputStarted || failed.cliOutputStarted));
}

/** Moves the turn to the next account and sets up what its retry sends.
 * Where a switch spends its time, one line per switch (account-switch.ts):
 * the choice of account, the old process closing, the thread copy, the record. */
/** The vendor refused this model on this account ("not supported when using
 * Codex with a ChatGPT account"): the refusal is recorded on the account
 * (model-refusals.ts), and when no other account would run the model the turn
 * retries here on the next model this account runs. The refused model was
 * most often a default ClikCode resolved, and failing the turn left the user
 * a chat that refused every message. Bounded: each refusal removes a model. */
async function retryOnAnotherModel(ctx: VendorTurnContext, failed: Failed): Promise<boolean> {
  const refused = ctx.model;
  if (!refused || (ctx.attempt.modelsRefused ?? 0) >= MAX_MODEL_RETRIES) return false;
  recordModelRefusal(ctx.account, refused);
  await ctx.checkpoint.persistNow();
  const now = Date.now();
  const elsewhere = nextUsableFailoverAccount(ctx.state, ctx.account, (item) => turnBackendForAccount(item) === 'vendor', new Map([[ctx.account.id, now]]), now, refused);
  if (elsewhere) return false;
  const next = await resolveNativeModel(ctx.harness, ctx.account);
  if (!next || next === refused) return false;
  ctx.attempt.modelsRefused = (ctx.attempt.modelsRefused ?? 0) + 1;
  diagnostic('vendor.model-refused', `${ctx.harness.displayName} does not run ${refused} on ${ctx.account.label}; using ${next}`);
  // The model is part of how the vendor process was launched.
  await leavePersistentTransport(ctx.session.id);
  ctx.model = next;
  ctx.session.model = next;
  if (!failed.cliOutputStarted) editAnswer(ctx, 'clear');
  return true;
}

const MAX_MODEL_RETRIES = 3;

async function switchAccount(ctx: VendorTurnContext, failed: Failed): Promise<void> {
  const { session, harness, attempt } = ctx;
  const { failure, failureKind, responseBefore, wroteBefore, cliOutputStarted } = failed;
  const from = ctx.account;
  const { value: moved, to } = await switchAccountAfterFailure({
    accounts: ctx.accounts, from, failure, kind: failureKind, signal: ctx.signal, harness: harness.command,
    carry: async (fallback, { switchAt, chooseMs }) => {
      // A refusal is not assistant work to continue on the next account.
      const attemptText = (session.pendingTurn?.response ?? '').slice(responseBefore);
      const refusalOnly = attemptText.trim() !== '' && echoesRefusal(attemptText, failure);
      const wrote = refusalOnly ? wroteBefore : Boolean(session.pendingTurn?.outputStarted || cliOutputStarted);
      // Closing after the last tool settled lets the vendor flush its own
      // transcript before the receiving account copies it.
      await leavePersistentTransport(session.id);
      const closeMs = Date.now() - switchAt - chooseMs;
      // Standbys hold only an initialized process, safe to reuse whether
      // or not the failed attempt produced output.
      const standby = standbyFor(session.id, fallback.id);
      const warm = standby ? await standby.ready : false;
      if (!warm) await closeStandby(session.id);
      // A warm process holds no snapshot. Carry only on a real failover,
      // from the vendor's flushed thread, then resume it on that process.
      const carriedThread = await moveThreadToAccount(session, harness, from, fallback);
      const carryMs = Date.now() - switchAt - chooseMs - closeMs;
      return {
        value: { wrote, carriedThread },
        fields: { closeMs, carryMs, carried: warm ? 'standby' : carriedThread ?? 'none' },
      };
    },
  });
  let { wrote, carriedThread } = moved!;
  // A structurally broken copied thread cannot safely receive only the
  // current request. A valid compaction is still a resumable thread.
  if (carriedThread && !await nativeThreadHoldsConversation(session, harness, to)) {
    forgetNativeThread(session);
    carriedThread = undefined;
  }
  attempt.nativeThreadRetried = false;
  const edit = session.pendingTurn?.response?.trim() ? 'new-paragraph' : 'clear';
  // The user's own request goes again; what the attempt wrote is in the
  // carried conversation.
  const nextRequest = ctx.askedText;
  if (carriedThread) {
    // ('present' counts as much as 'carried': both accounts run this
    // harness against one vendor home, so the thread never had to move.)
    // The flushed thread includes the handoff/delta already sent to it.
    // Never replay that framing on top of the carried conversation.
    ctx.turnText = nextRequest;
    if (wrote || session.pendingTurn?.response?.trim()) continueAnswer(ctx, edit);
  } else {
    // Built while the interrupted attempt's touched-file hints are still
    // on the checkpoint. The only path that rewrites the conversation:
    // this vendor's thread cannot be copied across.
    ctx.turnText = await retell(ctx, nextRequest, edit, wrote);
  }
}

/** A failed attempt: ends it, then retries in place or on another account (or throws). */
export async function recoverFromFailure(ctx: VendorTurnContext, observer: VendorObserver, record: AttemptRecord): Promise<void> {
  const { harness } = ctx;
  const { result, caughtTurnFailure, streamError, transport } = record;
  const carried = (caughtTurnFailure ?? {}) as { statusCode?: number; errorKind?: string };
  // A thrown transport error carries its own stderr/streams.
  const declared = caughtTurnFailure ? undefined : nativeTurnFailure(harness, result);
  const failure = caughtTurnFailure ?? declared!.failure;
  const failureKind = classifyTurnFailure(failure, {
    statusCode: result.statusCode ?? carried.statusCode ?? streamError?.statusCode,
    errorKind: result.errorKind ?? carried.errorKind ?? streamError?.kind,
    ...(result.rateLimitStatus ? { rateLimitStatus: result.rateLimitStatus } : {}),
    ...(declared ? { vendorError: declared.isResultError } : {}),
  }, harness.replyErrorPatterns ? { replyErrorPatterns: harness.replyErrorPatterns } : {});
  // Every path from here retries or ends the turn: this attempt is over.
  observer.recordUnfinishedAttempt('error');
  lifecycle('worker.turn.attempt-failed', {
    kind: failureKind, transport, account: ctx.account.id.slice(0, 8),
    message: (failure instanceof Error ? failure.message : String(failure)).slice(0, 8000),
  });
  const failed: Failed = { ...record, failure, failureKind };
  // signInForTurn marks the attempt's one sign-in (attempt.authRetried).
  if (failureKind === 'authentication-required' && !ctx.attempt.authRetried && await retryAfterSignIn(ctx, failed)) return;
  if (failureKind === 'native-thread-invalid' && !ctx.attempt.nativeThreadRetried) { await retryOnFreshThread(ctx, failed); return; }
  if (failureKind === 'account-ineligible' && isModelRefusal(failure) && await retryOnAnotherModel(ctx, failed)) return;
  await switchAccount(ctx, failed);
}

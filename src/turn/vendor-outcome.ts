/** What a vendor attempt's result means: the reply notice a harness reports as an
 * error, the thread bookkeeping after it, and the turn's completion. */
import { diagnostic } from '../runtime/lifecycle-log.js';
import { harnessReplyError } from '../runtime/lazy-bridge.js';
import { adoptListedNativeId } from '../session/discovery/cli-listing.js';
import { keepsNoHistory } from './thread-start.js';
import { forgetNativeThread } from '../session/native-thread.js';
import { nativeGeneratedTitle } from '../session/discovery/titles.js';
import { writeState } from '../session/state/write.js';
import { emitHarnessOutput } from '../harness/output.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { recordQuotaRefusal, recordSuccessfulAccountTurn } from './account-outcome.js';
import { endsWithLimitRefusal } from '../harness/transport/handoff-work.js';
import { settleHeldVendor } from './turn-steps.js';
import { completeTurnCheckpoint } from './turn-journal.js';
import { recordInvocation, showStopReason } from './turn-output.js';
import { editAnswer } from './vendor-thread-takeup.js';
import type { AttemptRecord } from './vendor-attempt.js';
import type { VendorObserver } from './vendor-observer.js';
import type { VendorTurnContext } from './vendor-turn-context.js';

/** Settles a finished attempt's result; true when it failed (a thrown error or
 * a result marked as one) and the recovery takes over. */
export async function settleAttempt(ctx: VendorTurnContext, observer: VendorObserver, record: AttemptRecord): Promise<boolean> {
  const { harness, session, prompter, checkpoint, signal } = ctx;
  const { caughtTurnFailure, environment } = record;
  let result = record.result;
  // A harness that reports a failed call as its reply (Hermes, over ACP
  // and the CLI alike) declares what those replies look like.
  const replyError = !result.isError ? harnessReplyError(harness, result.text ?? '') : undefined;
  if (replyError) {
    // The notice is not the answer: take it off what is shown and saved, so
    // the next account continues from real progress rather than a banner.
    // Read from the saved answer, which the title filter already produced;
    // a notice-only reply clears it.
    const onScreen = harnessReplyError(harness, session.pendingTurn?.response ?? '');
    const withoutNotice = onScreen?.withoutNotice;
    if (withoutNotice) {
      checkpoint.response(withoutNotice, 'replace');
      prompter?.response(withoutNotice, 'replace');
    } else if (onScreen) {
      editAnswer(ctx, 'clear');
    }
    result = { ...result, isError: true, errorMessage: replyError.notice, ...(replyError.statusCode !== undefined ? { statusCode: replyError.statusCode } : {}) };
    record.result = result;
  }
  // A failed attempt does not wait on its account's agents: on a spent account they may never end.
  if (result.isError) await settleHeldVendor(session.id, prompter, signal, { wait: false, from: { harness: harness.command, accountId: ctx.account.id } });
  if (!session.nativeSessionId && result.nativeSessionId) { session.nativeSessionId = result.nativeSessionId; session.nativeThreadAccountId = ctx.account.id; }
  if (!result.isError && !session.nativeSessionPreallocated) await adoptListedNativeId(harness, session, environment);
  if (session.nativeSessionId) observer.keepTransport(record.transport);
  // A route that keeps no history: forget the session, so the next turn
  // opens a fresh one and carries ClikCode's own transcript (the fresh-
  // thread replay above) instead of resuming into an empty memory.
  const statelessProvider = session.nativeTransport !== 'acp' && keepsNoHistory(harness, ctx.model);
  if (!result.isError && (result.nativeSessionStateless || statelessProvider)) forgetNativeThread(session);
  // A non-zero exit code alone is not treated as failure here: by this
  // point nativeTurnResult has already thrown if it found neither assistant
  // text nor tool work, so a result means a real, complete turn. A harness
  // can legitimately exit non-zero because one internal sub-step failed
  // (e.g. Codex's own shell-command execution) while still producing a full
  // final answer -- the exit code by itself doesn't distinguish that from a
  // genuine failure, but an explicit isError/errorMessage signal does. An
  // empty `text` after tool work (`noAssistantText`) is success everywhere.
  return Boolean(caughtTurnFailure || result.isError);
}

/** A turn that completed: its record, usage, title and output. */
export async function completeVendorTurn(ctx: VendorTurnContext, observer: VendorObserver, record: AttemptRecord): Promise<void> {
  const { harness, session, prompter, state } = ctx;
  const { result, environment } = record;
  session.nativeStartedAt ??= new Date().toISOString();
  delete session.nativeSessionPreallocated;
  // The harness exited with a tool it never settled. Another model turn
  // cannot collect output from a process that has already gone.
  if (observer.pendingWork.outstanding > 0) {
    const count = observer.pendingWork.outstanding;
    diagnostic('vendor.exited-with-tools-running', `${count} tool${count === 1 ? '' : 's'}`);
  }
  const usage = observer.usage() as TurnUsage | undefined;
  const invocation = recordInvocation(state, { sessionId: session.id, accountId: ctx.account.id, provider: harness.provider, model: ctx.model, startedAt: ctx.startedAt, usage });
  // Claude answers a background agent's end with its refusal when the account has just run out, and
  // the prompt still ends as answered. That is the account spent, not served: recorded as a refusal, so
  // the next turn moves on -- recorded as a success it cleared the mark and set the 100% reading aside.
  const refusal = endsWithLimitRefusal(session.pendingTurn?.response ?? result.text ?? '');
  if (refusal) recordQuotaRefusal(state, ctx.account, new Error(refusal));
  else recordSuccessfulAccountTurn(ctx.account);
  showStopReason(prompter, usage?.stopReason);
  const completedText = await completeTurnCheckpoint(session, ctx.checkpoint, result.text, {
    ...(harness.titleSource === 'vendor'
      ? { vendor: () => nativeGeneratedTitle(harness, session.nativeSessionId, session.workspace, environment) }
      : {}),
  });
  await writeState(state);
  if (!prompter) emitHarnessOutput({ session, text: completedText, usage: { attributedBy: harness.command, ...usage }, invocation, ...ctx.accounts.switched() });
}

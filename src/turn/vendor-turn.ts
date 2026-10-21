/** Run a turn through a vendor's CLI or structured session protocol. */
import { moveThreadToAccount, reconcileNativeThread } from '../session/carry.js';
import { closeStandby, leavePersistentTransport } from './vendor-process.js';
import { settleHeldVendor } from './turn-steps.js';
import type { AccountTurnInput } from './session-turn.js';
import { runAttempt } from './vendor-attempt.js';
import { createVendorObserver } from './vendor-observer.js';
import { completeVendorTurn, settleAttempt } from './vendor-outcome.js';
import { recoverFromFailure } from './vendor-recovery.js';
import { takeUp } from './vendor-thread-takeup.js';
import { createVendorTurnContext, type VendorTurnContext } from './vendor-turn-context.js';
import { withMoveNote } from './resource-notes.js';

/** The thread under the account this turn runs on (session/carry.ts). */
async function settleThread(ctx: VendorTurnContext): Promise<void> {
  const { session, harness } = ctx;
  const held = session.nativeThreadAccountId;
  // A vendor process from the account being left may still have it open.
  if (held && held !== ctx.account.id) await leavePersistentTransport(session.id);
  const outcome = await reconcileNativeThread(session, harness, ctx.state.accounts, ctx.account);
  if (outcome === 'carried' || outcome === 'forgotten' || session.nativeThreadAccountId !== held) await ctx.checkpoint.persistNow();
}

/** Everything before the first attempt: the thread and account the turn starts on. */
async function startVendorTurn(ctx: VendorTurnContext): Promise<void> {
  const { session, harness, prompter, signal, checkpoint } = ctx;
  // The old CLI finishes its Agent calls and their follow-up, and closing it
  // flushes its thread before a new account reads the copy.
  await settleHeldVendor(session.id, prompter, signal);
  // Work a previous reply left running (a background command, a sub-agent) is not waited on: on
  // this process it runs on beside this turn, and a process the conversation leaves keeps it, its
  // end told to the account the conversation is on by then (handoff-work.ts).
  // The thread goes with the conversation, as on a switch mid-turn; only
  // one that cannot be carried starts afresh.
  if (await ctx.accounts.start(async (to) => {
    await leavePersistentTransport(session.id);
    await moveThreadToAccount(session, harness, ctx.account, to);
  })) {
    await checkpoint.persistNow();
  }
  // Whoever chose this account and whenever, the thread has to be in its
  // profile before anything resumes it. One that cannot be carried is
  // forgotten here, so the line below takes the conversation up afresh.
  await settleThread(ctx);
  // A fresh native thread (no nativeSessionId yet) with prior ClikCode
  // messages already on the session means this conversation is continuing
  // under a different native identity than whatever produced those messages
  // -- a provider switch, a switch back, a fork, "Resume in". The vendor
  // process about to start has no memory of any of it unless it is given
  // it: takeUp writes it as the vendor's own thread, or transfers it. The
  // failover retries take the same path mid-turn.
  if ((!session.nativeSessionId || session.nativeSessionPreallocated) && ctx.baseMessages.length > 0) {
    ctx.turnText = await takeUp(ctx, ctx.turnText, { interrupted: false, withJournal: false });
  }
}

/**
 * Runs one durable local session turn. Local sessions resolve an env reference
 * only in this process and record normalized, credential-free usage.
 *
 * Each attempt runs the vendor; a failed one is recovered in place or moved to
 * another account (vendor-recovery.ts) and the loop runs it again.
 */
export async function sendVendorTurn(input: AccountTurnInput): Promise<void> {
  const ctx = await createVendorTurnContext(input);
  try {
    await startVendorTurn(ctx);
    // A chat that just moved here: the agent is told so, ahead of everything
    // the turn sends -- the taken-up conversation included (session/move.ts).
    ctx.turnText = withMoveNote(ctx.session, ctx.turnText);
    const observer = createVendorObserver(ctx);
    ctx.askedText = ctx.turnText;
    for (;;) {
      const attempt = await runAttempt(ctx, observer);
      if (await settleAttempt(ctx, observer, attempt)) {
        await recoverFromFailure(ctx, observer, attempt);
        continue;
      }
      await completeVendorTurn(ctx, observer, attempt);
      return;
    }
  } finally {
    // A standby the turn did not need (it answered on its own account, or
    // ended otherwise) is a second vendor child: closed with the turn.
    await closeStandby(ctx.session.id);
    await ctx.checkpoint.flush();
  }
}

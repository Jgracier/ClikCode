/** Run a turn through a vendor's CLI or structured session protocol. */
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import { moveThreadToAccount, reconcileNativeThread } from '../session/carry.js';
import type { prepareAttachments } from '../session/attachments.js';
import { INTERRUPTED_TURN_REQUEST } from './failover-prompt.js';
import { closePersistentTransport, closeStandby, persistentWorkRunning, waitForPersistentWork } from './vendor-process.js';
import { settleHeldVendor } from './turn-steps.js';
import type { TurnRunOptions } from './session-turn.js';
import { runAttempt } from './vendor-attempt.js';
import { attachSwarm, createVendorObserver } from './vendor-observer.js';
import { completeVendorTurn, settleAttempt } from './vendor-outcome.js';
import { recoverFromFailure } from './vendor-recovery.js';
import { takeUp } from './vendor-thread-takeup.js';
import { createVendorTurnContext, type VendorTurnContext } from './vendor-turn-context.js';

/** The thread under the account this turn runs on (session/carry.ts). */
async function settleThread(ctx: VendorTurnContext): Promise<void> {
  const { session, harness } = ctx;
  const held = session.nativeThreadAccountId;
  // A vendor process from the account being left may still have it open.
  if (held && held !== ctx.account.id) await closePersistentTransport(session.id);
  const outcome = await reconcileNativeThread(session, harness, ctx.state.accounts, ctx.account);
  if (outcome === 'carried' || outcome === 'forgotten' || session.nativeThreadAccountId !== held) await ctx.checkpoint.persistNow();
}

/** Everything before the first attempt: the thread and account the turn starts on. */
async function startVendorTurn(ctx: VendorTurnContext): Promise<void> {
  const { session, harness, prompter, signal, checkpoint } = ctx;
  // The old CLI finishes its Agent calls and their follow-up, and closing it
  // flushes its thread before a new account reads the copy.
  await settleHeldVendor(session.id, prompter, signal);
  // A previous reply may have left Agent calls running. Even a manual account
  // choice for this next prompt cannot close or copy their still-changing
  // thread; let them finish in the original process first.
  if (await persistentWorkRunning(session.id)) {
    prompter?.phase('waiting for running work');
    await waitForPersistentWork(session.id, signal);
  }
  // The thread goes with the conversation, as on a switch mid-turn; only
  // one that cannot be carried starts afresh.
  if (await ctx.accounts.start(async (to) => {
    await closePersistentTransport(session.id);
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
    ctx.turnText = await takeUp(ctx, ctx.turnText, { interrupted: ctx.text === INTERRUPTED_TURN_REQUEST, withJournal: false });
  }
}

/**
 * Runs one durable local session turn. Local sessions resolve an env reference
 * only in this process and record normalized, credential-free usage.
 *
 * Each attempt runs the vendor; a failed one is recovered in place or moved to
 * another account (vendor-recovery.ts) and the loop runs it again.
 */
export async function sendVendorTurn(input: {
  state: HarnessState;
  session: HarnessSession;
  account: AiHarnessAccount;
  model: string | null;
  text: string;
  prepared: Awaited<ReturnType<typeof prepareAttachments>>;
  turnText: string;
  startedAt: number;
  signal?: AbortSignal;
  run: TurnRunOptions;
}): Promise<void> {
  const ctx = await createVendorTurnContext(input);
  let stopSwarmWatch = (): void => undefined;
  try {
    await startVendorTurn(ctx);
    const observer = createVendorObserver(ctx);
    await attachSwarm(ctx, observer.onActivity, (stop) => { stopSwarmWatch = stop; });
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
    stopSwarmWatch();
    // A standby the turn did not need (it answered on its own account, or
    // ended otherwise) is a second vendor child: closed with the turn.
    await closeStandby(ctx.session.id);
    await ctx.checkpoint.flush();
  }
}

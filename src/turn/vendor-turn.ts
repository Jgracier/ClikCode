/** Run a turn through a vendor's CLI or structured session protocol. */
import { moveThreadToAccount, reconcileNativeThread } from '../session/carry.js';
import { lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { liveCallsForSwitch } from './live-settings.js';
import { completeTurnCheckpoint, discardInterruptedTurn } from './turn-journal.js';
import { closePersistentTransport, closeStandby, leavePersistentTransport } from './vendor-process.js';
import { settleHeldVendor } from './turn-steps.js';
import type { AccountTurnInput } from './session-turn.js';
import { runAttempt } from './vendor-attempt.js';
import { createVendorObserver } from './vendor-observer.js';
import { completeVendorTurn, settleAttempt } from './vendor-outcome.js';
import { recoverFromFailure } from './vendor-recovery.js';
import { takeUp } from './vendor-thread-takeup.js';
import { forgetNativeThread, restoreNativeThread } from '../session/native-thread.js';
import { nativeThreadHoldsConversation } from './native-thread-continuity.js';
import { returnPrompt } from './thread-return.js';
import { targetContextWindow, transferBudget } from './transfer.js';
import { modelsDevFiles } from '../harness/accounts/goose-discovery.js';
import { sessionTurnTransport } from '../harness/transport/select.js';
import { maxPromptArgvBytes } from '../runtime/lazy-bridge.js';
import { writeFullRecord } from '../session/full-record.js';
import { stateDirectory } from '../session/store/paths.js';
import { createVendorTurnContext, type VendorTurnContext } from './vendor-turn-context.js';
import { withMoveNote } from './resource-notes.js';

/** The thread under the account this turn runs on (session/carry.ts). */
async function settleThread(ctx: VendorTurnContext): Promise<void> {
  const { session, harness } = ctx;
  const held = session.nativeThreadAccountId;
  // A vendor process from the account being left may still have it open.
  if (held && held !== ctx.account.id) await leavePersistentTransport(session.id);
  const outcome = await reconcileNativeThread(session, harness, ctx.state.accounts, ctx.account);
  // A thread whose parent chain is broken cannot take only the current request: the vendor would resume
  // from a fragment. It is forgotten here and the conversation is told to it whole (a compaction is a valid root).
  let broken = false;
  if (session.nativeSessionId && !await nativeThreadHoldsConversation(session, harness, ctx.account)) {
    await closePersistentTransport(session.id);
    forgetNativeThread(session);
    broken = true;
  }
  if (outcome === 'carried' || outcome === 'forgotten' || session.nativeThreadAccountId !== held || broken) await ctx.checkpoint.persistNow();
}

/** Everything before the first attempt: the thread and account the turn starts on. */
async function startVendorTurn(ctx: VendorTurnContext): Promise<void> {
  const { session, harness, prompter, signal, checkpoint } = ctx;
  // A background command a previous reply left runs on beside this turn; a process the conversation
  // leaves keeps its work, the end told to the account the conversation is on by then (handoff-work.ts).
  // The thread goes with the conversation, as on a switch mid-turn; only
  // one that cannot be carried starts afresh.
  const returningThrough = restoreNativeThread(session, harness.command);
  // Heal identities guessed from plain assistant output by older versions.
  // A stateless adapter always takes up the canonical conversation anew.
  if (harness.turn?.stateless) forgetNativeThread(session);
  // The old CLI's Agent calls and their follow-up end before a turn on the same account reads
  // its thread (closing it flushes the thread); a process the conversation is leaving (a
  // spent account, another harness) is not waited on: its agents run on (settleHeldVendor).
  const here = { harness: harness.command, accountId: ctx.account.id };
  let settled = false;
  const moved = await ctx.accounts.start(async (to) => {
    settled = true;
    await settleHeldVendor(session.id, prompter, signal, { to: { harness: harness.command, accountId: to.id } });
    await leavePersistentTransport(session.id);
    await moveThreadToAccount(session, harness, ctx.account, to);
  });
  if (!settled) await settleHeldVendor(session.id, prompter, signal, { to: here });
  if (moved) await checkpoint.persistNow();
  // Whoever chose this account and whenever, the thread has to be in its
  // profile before anything resumes it. One that cannot be carried is
  // forgotten here, so the line below takes the conversation up afresh.
  await settleThread(ctx);
  if (returningThrough !== undefined && session.nativeSessionId) {
    const transport = sessionTurnTransport(harness, session);
    const argvBound = (transport === 'structured-cli' || transport === 'text-cli') && harness.turn?.promptInput !== 'stdin';
    const contextWindow = await targetContextWindow(ctx.state.sessions, harness.command, ctx.model, modelsDevFiles()).catch(quiet('turn/vendor-turn'));
    const budget = transferBudget({ ...(contextWindow ? { contextWindow } : {}), ...(argvBound ? { argvLimit: maxPromptArgvBytes() } : {}) });
    const missed = ctx.baseMessages.slice(returningThrough);
    if (missed.length) {
      const recordPath = await writeFullRecord({ ...session, pendingTurn: undefined }, stateDirectory());
      ctx.turnText = returnPrompt(session, ctx.baseMessages, returningThrough, ctx.turnText, budget, recordPath);
    }
  }
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

/** The user's mid-turn choice, before an attempt starts. The attempt already
 * running is left alone. Another account of this provider is the next attempt;
 * another provider or route continues the same request there.
 * A failover moves the account on its own: only an account id the user changed
 * since `seenAccount` is adopted, so the retry is not pulled back. Plan mode
 * the vendor itself left is kept until the user changes it. */
async function followLiveSettings(
  ctx: VendorTurnContext, seen: { accountId: string | null | undefined; plan: boolean | undefined },
): Promise<'switch' | void> {
  const live = ctx.run.liveSettings;
  const { session } = ctx;
  if (liveCallsForSwitch(live, { route: session.route, nativeHarness: ctx.harness.command, accountId: ctx.account.id, accountProvider: ctx.account.provider }, ctx.state.accounts)) {
    await closePersistentTransport(session.id);
    const progressed = Boolean(session.pendingTurn?.response?.trim() || session.pendingTurn?.outputStarted);
    if (progressed) await completeTurnCheckpoint(session, ctx.checkpoint, session.pendingTurn?.response ?? '');
    else await discardInterruptedTurn(session.id, ctx.text);
    lifecycle('turn.switch', { route: live?.route, ...(live?.accountId ? { account: String(live.accountId).slice(0, 8) } : {}) });
    return 'switch';
  }
  if (!live) return;
  if (live.accountId !== seen.accountId) {
    seen.accountId = live.accountId;
    const next = live.accountId ? ctx.state.accounts.find((item) => item.id === live.accountId) : undefined;
    if (next && next.provider === ctx.account.provider && next.id !== ctx.account.id) {
      await closePersistentTransport(session.id);
      ctx.account = next;
      session.accountId = next.id;
      await settleThread(ctx);
    }
  }
  if (live.model !== undefined && live.model !== ctx.model) {
    ctx.model = live.model ?? null;
    session.model = ctx.model;
  }
  if (live.effort !== undefined && live.effort !== session.effort) session.effort = live.effort;
  if (live.permissionMode && live.permissionMode !== session.permissionMode) session.permissionMode = live.permissionMode;
  const wantedPlan = live.planMode === true;
  if (seen.plan === undefined) seen.plan = session.planMode === true;
  if (wantedPlan !== seen.plan) {
    if (wantedPlan) session.planMode = true;
    else delete session.planMode;
    seen.plan = wantedPlan;
  }
}

/**
 * Runs one durable local session turn. Local sessions resolve an env reference
 * only in this process and record normalized, credential-free usage.
 *
 * Each attempt runs the vendor; a failed one is recovered in place or moved to
 * another account (vendor-recovery.ts) and the loop runs it again.
 */
export async function sendVendorTurn(input: AccountTurnInput): Promise<'switch' | void> {
  const ctx = await createVendorTurnContext(input);
  // The account this turn holds now. A later failover changes the account it runs;
  // only a different id in the live settings is the user's choice.
  const seen = { accountId: ctx.account.id as string | null | undefined, plan: undefined as boolean | undefined };
  try {
    await startVendorTurn(ctx);
    // A chat that just moved here: the agent is told so, ahead of everything
    // the turn sends -- the taken-up conversation included (session/move.ts).
    ctx.turnText = withMoveNote(ctx.session, ctx.turnText);
    const observer = createVendorObserver(ctx);
    for (;;) {
      if (await followLiveSettings(ctx, seen) === 'switch') return 'switch';
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

/** What a failed vendor attempt does next: each recovery is a named step that
 * says whether the turn runs again ('retry') or leaves the choice to the next
 * one ('pass'); when none applies the turn moves to another account. */
import chalk from 'chalk';
import { forgetNativeThread } from '../session/native-thread.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { closePersistentTransport, closeStandby, rememberFallbackTurn, standbyFor, usesFallbackTurn } from './vendor-process.js';
import { moveThreadToAccount } from '../session/carry.js';
import { switchAccountAfterFailure } from './account-switch.js';
import { classifyAccountFailure, isTransientStartFailure, TRANSIENT_START_RETRY_MS, type AccountFailureKind } from './failover.js';
import { INTERRUPTED_TURN_REQUEST } from './failover-prompt.js';
import { nativeTurnFailure } from '../harness/protocol/turn-result.js';
import { continueAnswer, editAnswer, retell } from './vendor-thread-takeup.js';
import { signInForTurn } from './vendor-sign-in.js';
import type { AttemptRecord } from './vendor-attempt.js';
import type { VendorObserver } from './vendor-observer.js';
import { effortKey, turnEffort, type AttemptState, type VendorTurnContext } from './vendor-turn-context.js';

/** A vendor refusing the reasoning level itself, in the words the CLIs use. */
const EFFORT_REJECTED = /\b(?:unknown|invalid|unsupported|not supported)\b[^\n]{0,40}\b(?:reasoning[ _-]?)?effort\b|\beffort\b[^\n]{0,40}\b(?:is not supported|not supported|unsupported|invalid)\b/i;

/** Whether a failed turn is the vendor refusing the reasoning level: an ACP
 * session that offers no such level (acp-client.ts), or a CLI saying so in
 * its message or stderr -- never read from a model's reply. */
export function isEffortRefusal(failure: Error): boolean {
  if ((failure as { acpUnsupportedEffort?: unknown }).acpUnsupportedEffort === true) return true;
  const stderr = (failure as { stderrTail?: unknown }).stderrTail;
  return EFFORT_REJECTED.test([failure.message, typeof stderr === 'string' ? stderr : ''].join('\n'));
}

/** Whether an attempt's streamed text is only the account refusal it then
 * failed with ("You've hit your session limit · resets 3:50pm" streamed as
 * a message, then "Internal error: You've hit your session limit …"). */
export function echoesRefusal(text: string, failure: unknown): boolean {
  const flat = (value: string): string => value.toLowerCase().replace(/^\s*internal error:\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const said = flat(text);
  const refused = flat(failure instanceof Error ? failure.message : String(failure));
  return said.length > 0 && refused.length > 0 && (refused.includes(said) || said.includes(refused));
}

export type Recovery = 'effort' | 'transient' | 'fallback-turn' | 'sign-in' | 'native-thread';

/** The recoveries a failure could take, in the order they are tried. Pure: a
 * recovery may still decline (a sign-in that fails, a compatibility turn
 * already in use) and the next is tried. */
export function recoveryCandidates(facts: {
  failure: Error;
  failureKind: AccountFailureKind;
  cliOutputStarted: boolean;
  /** The reasoning level asked for, if any. */
  effort: string | undefined;
  cliTransport: boolean;
  hasFallbackTurn: boolean;
  attempt: Pick<AttemptState, 'effortRetried' | 'transientRetried' | 'authRetried' | 'nativeThreadRetried'>;
}): Recovery[] {
  const { failure, failureKind, cliOutputStarted, attempt } = facts;
  const order: Recovery[] = [];
  // A reasoning level the model does not take. Which levels a model
  // takes is often only stated by the refusal itself ("Unknown effort
  // \"medium\". Supported: high, max." -- Command Code, where it varies
  // per model and is published nowhere else).
  if (!cliOutputStarted && facts.effort && !attempt.effortRetried && isEffortRefusal(failure)) order.push('effort');
  // A start that failed for a moment (failover.ts isTransientStartFailure):
  // nothing was sent, so once more in place.
  if (!cliOutputStarted && !attempt.transientRetried && isTransientStartFailure(failure)) order.push('transient');
  // A turn contract an older vendor build rejects outright.
  if (failureKind === 'other' && !cliOutputStarted && facts.hasFallbackTurn && facts.cliTransport) order.push('fallback-turn');
  if (failureKind === 'authentication-required' && !attempt.authRetried) order.push('sign-in');
  if (failureKind === 'native-thread-invalid' && !attempt.nativeThreadRetried) order.push('native-thread');
  return order;
}

type Decision = 'retry' | 'pass';
type Failed = AttemptRecord & { failure: Error; failureKind: AccountFailureKind };

/** The vendor's default level, once the conversation's is refused: it drops
 * to it and says so, then runs the turn once more. */
async function retryWithoutEffort(ctx: VendorTurnContext, _failed: Failed): Promise<Decision> {
  ctx.attempt.effortRetried = true;
  ctx.prompter?.activity(chalk.yellow(`${ctx.harness.displayName} does not take effort ${ctx.session.effort} on this model; using its default`));
  ctx.session.effortRefused = effortKey(ctx);
  await ctx.checkpoint.persistNow();
  return 'retry';
}

async function retryTransientStart(ctx: VendorTurnContext, _failed: Failed): Promise<Decision> {
  ctx.attempt.transientRetried = true;
  ctx.prompter?.phase('retrying');
  await new Promise((resolve) => setTimeout(resolve, TRANSIENT_START_RETRY_MS));
  return 'retry';
}

/** Retry once on the harness's declared fallback contract, and remember it for that build. */
async function retryOnFallbackTurn(ctx: VendorTurnContext, _failed: Failed): Promise<Decision> {
  if (await usesFallbackTurn(ctx.harness)) return 'pass';
  await rememberFallbackTurn(ctx.harness);
  ctx.prompter?.phase('using compatibility turn');
  return 'retry';
}

/** Reactive counterpart to aiHarnessSelect's proactive login check: a
 * harness with no statusArgv gets no pre-turn "are you logged in?" probe at
 * all (harnessNeedsLogin returns false without one), so its first real
 * failure signal is the turn itself erroring out. The account is marked
 * signed out by accounts.after, if signing in here does not fix it. */
async function retryAfterSignIn(ctx: VendorTurnContext, failed: Failed): Promise<Decision> {
  if (!await signInForTurn(ctx, failed.environment)) return 'pass';
  // The failed reply may already be on screen; the retry replaces it.
  editAnswer(ctx, 'clear');
  return 'retry';
}

/** Confirmed live: switching this session to a different account of the same
 * provider used to leave a stale nativeSessionId in place, and resuming it
 * failed with exactly this vendor error. Recovering here means any way a
 * thread id ends up invalid degrades to "start fresh with real context
 * replayed": session.messages is the durable, vendor-agnostic source of
 * truth, and nativeSessionId is a disposable optimization. */
async function retryOnFreshThread(ctx: VendorTurnContext, failed: Failed): Promise<Decision> {
  ctx.attempt.nativeThreadRetried = true;
  await closePersistentTransport(ctx.session.id);
  forgetNativeThread(ctx.session);
  ctx.turnText = await retell(ctx, ctx.session.pendingTurn?.outputStarted || failed.cliOutputStarted ? INTERRUPTED_TURN_REQUEST : ctx.askedText, 'clear');
  return 'retry';
}

const RECOVERIES: Record<Recovery, (ctx: VendorTurnContext, failed: Failed) => Promise<Decision>> = {
  effort: retryWithoutEffort,
  transient: retryTransientStart,
  'fallback-turn': retryOnFallbackTurn,
  'sign-in': retryAfterSignIn,
  'native-thread': retryOnFreshThread,
};

/** Moves the turn to the next account and sets up what its retry sends.
 * Where a switch spends its time, one line per switch (account-switch.ts):
 * the choice of account, the old process closing, the thread copy, the record. */
async function switchAccount(ctx: VendorTurnContext, failed: Failed): Promise<void> {
  const { session, harness, checkpoint, prompter, attempt } = ctx;
  const { failure, failureKind, responseBefore, wroteBefore, cliOutputStarted } = failed;
  const from = ctx.account;
  const { value: moved } = await switchAccountAfterFailure({
    accounts: ctx.accounts, from, failure, kind: failureKind, signal: ctx.signal, harness: harness.command,
    carry: async (fallback, { switchAt, chooseMs }) => {
      // Claude streams "You've hit your session limit · resets …" as message
      // text, then fails the prompt. That text is the refusal, not an
      // answer: it is taken back off the turn, and the next account is
      // asked the request itself rather than to continue it.
      const attemptText = (session.pendingTurn?.response ?? '').slice(responseBefore);
      const refusalOnly = attemptText.trim() !== '' && echoesRefusal(attemptText, failure);
      if (refusalOnly) {
        const earlier = (session.pendingTurn?.response ?? '').slice(0, responseBefore);
        checkpoint.response(earlier, 'replace');
        prompter?.response(earlier, 'replace');
        if (session.pendingTurn && !wroteBefore) session.pendingTurn.outputStarted = false;
      }
      // The answer on screen stays when this attempt already wrote one: the
      // next account carries on from it, so clearing it made the first half
      // vanish. An attempt that produced nothing is asked again in the
      // request's own words. "Continue" there points at the previous
      // finished turn, and retelling the transcript repeats a conversation
      // the carried thread already holds.
      const wrote = refusalOnly ? wroteBefore : Boolean(session.pendingTurn?.outputStarted || cliOutputStarted);
      // Closing after the last tool settled lets the vendor flush its own
      // transcript before the receiving account copies it.
      await closePersistentTransport(session.id);
      const closeMs = Date.now() - switchAt - chooseMs;
      // The account this turn opened a standby for, its thread loaded as it
      // stood before this turn: taken up when the attempt wrote nothing, so
      // its copy is still the whole conversation. Anything else starts cold.
      const standby = !wrote ? standbyFor(session.id, fallback.id) : undefined;
      const warm = standby ? await standby.ready : false;
      if (!warm) await closeStandby(session.id);
      // The thread as it stood before this turn is already in the account's
      // profile (copied with the standby, or for a CLI harness on its own):
      // copying again would bring the refused attempt with it.
      const precopied = warm || (!wrote && attempt.threadCopiedTo === fallback.id);
      const carriedThread = precopied ? 'present' as const : await moveThreadToAccount(session, harness, from, fallback);
      if (precopied && session.nativeSessionId) session.nativeThreadAccountId = fallback.id;
      const carryMs = Date.now() - switchAt - chooseMs - closeMs;
      return {
        value: { wrote, carriedThread },
        fields: { closeMs, carryMs, carried: warm ? 'standby' : precopied ? 'precopied' : carriedThread ?? 'none' },
      };
    },
  });
  const { wrote, carriedThread } = moved!;
  attempt.nativeThreadRetried = false;
  const edit = session.pendingTurn?.response?.trim() ? 'new-paragraph' : 'clear';
  const nextRequest = wrote ? INTERRUPTED_TURN_REQUEST : ctx.askedText;
  if (carriedThread) {
    // ('present' counts as much as 'carried': both accounts run this
    // harness against one vendor home, so the thread never had to move.)
    ctx.turnText = nextRequest;
    if (wrote) continueAnswer(ctx, edit);
  } else {
    // Built while the interrupted attempt's touched-file hints are still
    // on the checkpoint. The only path that rewrites the conversation:
    // this vendor's thread cannot be copied across.
    ctx.turnText = await retell(ctx, nextRequest, edit);
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
  const failureKind = classifyAccountFailure(failure, {
    statusCode: result.statusCode ?? carried.statusCode ?? streamError?.statusCode,
    errorKind: result.errorKind ?? carried.errorKind ?? streamError?.kind,
    ...(result.rateLimitStatus ? { rateLimitStatus: result.rateLimitStatus } : {}),
    ...(declared ? { isResultError: declared.isResultError } : {}),
    ...(harness.replyErrorPatterns ? { replyErrorPatterns: harness.replyErrorPatterns } : {}),
  });
  // Every path from here retries or ends the turn: this attempt is over.
  observer.recordUnfinishedAttempt('error');
  lifecycle('worker.turn.attempt-failed', {
    kind: failureKind, transport, account: ctx.account.id.slice(0, 8),
    message: (failure instanceof Error ? failure.message : String(failure)).slice(0, 8000),
  });
  const failed: Failed = { ...record, failure, failureKind };
  const candidates = recoveryCandidates({
    failure, failureKind, cliOutputStarted: record.cliOutputStarted, effort: turnEffort(ctx),
    cliTransport: transport === 'structured-cli' || transport === 'text-cli',
    hasFallbackTurn: Boolean(harness.fallbackTurn), attempt: ctx.attempt,
  });
  for (const recovery of candidates) {
    if (await RECOVERIES[recovery](ctx, failed) === 'retry') return;
  }
  await switchAccount(ctx, failed);
}

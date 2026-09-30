/** Select a usable account for a turn or a failover. */
import { noteStoredQuota } from './account-switch.js';
import { accountCanTakeTurn } from '../harness/accounts/usage-reading.js';
import { isDirectModelProvider } from '../runtime/lazy-bridge.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { usageExhaustedMessage } from './usage-exhausted.js';
import { accountVerification, verificationNotice, type AccountFailureKind } from './failover.js';
import { recordQuotaRefusal } from './account-outcome.js';
import { isTurnCancelled, turnCancelledError } from '../agent/cancellation.js';
import { readState } from '../session/state/read.js';

/** Credentials do not select a transport by themselves: tool-style providers
 * use their CLI even when the account supplies an API key. */
export function turnBackendForAccount(account: AiHarnessAccount): 'vendor' | 'direct' {
  return account.authKind === 'api-key' && isDirectModelProvider(account.provider) ? 'direct' : 'vendor';
}

export function matchesDirectTurnModel(account: AiHarnessAccount, model: string): boolean {
  return turnBackendForAccount(account) === 'direct' && account.models.includes(model);
}

/** Whether any account of this provider, on this transport, can still take
 * the turn by the one rule. "All accounts exhausted" -- and the offer to
 * resume on another provider that follows it -- is only true when not. */
export function providerHasAccountForTurn(
  state: HarnessState, provider: string, matchesTransport: (candidate: AiHarnessAccount) => boolean, now: number = Date.now(),
): boolean {
  return state.accounts.some((candidate) => candidate.provider === provider && matchesTransport(candidate) && accountCanTakeTurn(candidate, now));
}

export function nextUsableFailoverAccount(
  state: HarnessState,
  current: AiHarnessAccount,
  matchesTransport: (candidate: AiHarnessAccount) => boolean,
  attempted: ReadonlySet<string>,
): AiHarnessAccount | undefined {
  // An account the vendor is holding for verification refuses every turn
  // until the user confirms it, so trying it only fails the switch.
  const candidates = state.accounts.filter((candidate) => candidate.id !== current.id && !attempted.has(candidate.id)
    && candidate.provider === current.provider && candidate.status === 'ready' && !candidate.verification
    && matchesTransport(candidate));
  const usable: Array<{ account: AiHarnessAccount; remaining?: number }> = [];
  for (const candidate of candidates) {
    // Stored usage only. Asking the vendor here ran a probe per account
    // before the retry, which is the multi-minute switch. An account whose
    // figure says it is empty is skipped. One with no figure is still
    // eligible and is classified when its own turn comes back.
    const remaining = noteStoredQuota(candidate, state);
    if (remaining === 0) continue;
    usable.push({ account: candidate, ...(remaining === undefined ? {} : { remaining }) });
  }
  // Measured room first. An account with no figure never outranks one that
  // has some, and it is not treated as empty either.
  return usable.sort((left, right) => (right.remaining ?? Number.NEGATIVE_INFINITY) - (left.remaining ?? Number.NEGATIVE_INFINITY))[0]?.account;
}

/** Decide the first account from stored usage before starting a provider. */
export function initialAccountChoice(
  state: HarnessState,
  current: AiHarnessAccount,
  policy: HarnessSession['accountFailover'],
  matchesBackend: (candidate: AiHarnessAccount) => boolean,
  attempted: Set<string>,
): { kind: 'continue' } | { kind: 'switch'; account: AiHarnessAccount } | { kind: 'exhausted'; error: Error } {
  if (policy !== 'on-quota-exhausted' || noteStoredQuota(current, state) !== 0) return { kind: 'continue' };
  attempted.add(current.id);
  const fallback = nextUsableFailoverAccount(state, current, matchesBackend, attempted);
  if (fallback) return { kind: 'switch', account: fallback };
  return {
    kind: 'exhausted',
    error: new Error(usageExhaustedMessage(state.accounts.filter((candidate) => attempted.has(candidate.id)))),
  };
}

/** Report exhaustion only when no account on this backend can still run. */
export function terminalFailoverError(input: {
  state: HarnessState;
  current: AiHarnessAccount;
  attempted: ReadonlySet<string>;
  matchesBackend: (candidate: AiHarnessAccount) => boolean;
  exhaustedAny: boolean;
  lastFailure: unknown;
  lastOtherFailure?: unknown;
}): unknown {
  const { state, current, attempted, matchesBackend, exhaustedAny, lastFailure, lastOtherFailure } = input;
  if (!exhaustedAny) return lastFailure;
  if (providerHasAccountForTurn(state, current.provider, matchesBackend)) return lastOtherFailure ?? lastFailure;
  return new Error(usageExhaustedMessage(
    state.accounts.filter((candidate) => attempted.has(candidate.id) || candidate.id === current.id),
  ));
}

/** Where a turn stands across its failed attempts. */
export interface FailoverTally {
  /** Accounts already tried, each at most once, so a broken harness cannot cycle. */
  attempted: Set<string>;
  /** Whether any account actually ran out, as opposed to failing some other
   * way. Decides whether "Usage Exhausted" is the truth at the end. */
  exhaustedAny: boolean;
  /** The last failure that was not running out, for when running out is not
   * the whole story. */
  lastOtherFailure?: unknown;
}

/** The one failover step, after an attempt failed on `account`: the account
 * that takes the turn next, or the error that ends it.
 *
 * Shared by both account backends (vendor-turn.ts, direct-turn.ts), because
 * two copies drifted: the direct copy had no cancel guard, so Esc aborted the
 * request, the abort was classed "other", and the turn retried on the next
 * account with the already-aborted signal -- until every account had been
 * walked.
 *
 * Failover is about finding an account that can still work, so it is not
 * gated on a quota refusal: a turn that died any other way still moves on.
 * Only a quota refusal marks the account spent, though -- a crash says nothing
 * about how much allowance is left. A rejected REQUEST is not an account
 * problem at all: every account refuses the same argv the same way (ClikCode
 * once sent --effort to Antigravity, then walked seven accounts collecting
 * the same refusal), so it is surfaced as the vendor worded it. */
export async function accountAfterFailure(input: {
  state: HarnessState;
  session: HarnessSession;
  account: AiHarnessAccount;
  failure: unknown;
  kind: AccountFailureKind;
  signal?: AbortSignal;
  matchesBackend: (candidate: AiHarnessAccount) => boolean;
  tally: FailoverTally;
  /** Saves what this step recorded on the account. */
  persist: () => Promise<void>;
  notice?: (message: string) => void;
}): Promise<AiHarnessAccount> {
  const { state, session, account, failure, kind, tally } = input;
  // Stopped, not failed: whatever the attempt died of, it died because it was
  // cancelled, and no other account is owed the request.
  if (input.signal?.aborted || isTurnCancelled(failure) || (failure as Error | undefined)?.name === 'AbortError') {
    throw isTurnCancelled(failure) ? failure : turnCancelledError();
  }
  if (kind === 'authentication-required') account.status = 'needs_login';
  if (kind === 'request-invalid') { await input.persist(); throw failure; }
  if (kind === 'quota-exhausted') {
    recordQuotaRefusal(state, account, failure);
    tally.exhaustedAny = true;
  } else tally.lastOtherFailure = failure;
  tally.attempted.add(account.id);
  const verification = kind === 'account-ineligible' ? accountVerification(failure) : undefined;
  if (verification) {
    account.verification = { ...verification, at: new Date().toISOString() };
    input.notice?.(verificationNotice(verification));
  }
  await input.persist();
  // Running out reads the same whether or not failover is on. With it off
  // there is simply nowhere to switch to, which is the same outcome as having
  // switched everywhere and found nothing -- so it says the same thing rather
  // than whatever the vendor happened to call it ("Payment Required").
  if (session.accountFailover !== 'on-quota-exhausted') {
    if (!tally.exhaustedAny) throw failure;
    throw new Error(usageExhaustedMessage([account]));
  }
  const fallback = nextUsableFailoverAccount(state, account, input.matchesBackend, tally.attempted);
  if (fallback) return fallback;
  throw terminalFailoverError({
    state, current: account, attempted: tally.attempted, matchesBackend: input.matchesBackend,
    exhaustedAny: tally.exhaustedAny, lastFailure: failure, lastOtherFailure: tally.lastOtherFailure,
  });
}

/** The conversation's account, as a turn that moved to `to` records it.
 *
 * The account a turn runs on is the turn's own; the conversation's is the
 * user's too. A window's /settings or /accounts can change it mid-turn, and
 * the turn's copy then wrote its failover choice straight over that: the
 * three-way merge lets a field this process changed win. So the turn records
 * its move only while the conversation is still on the account the turn last
 * recorded -- otherwise the user's choice stands, for the next turn -- and
 * saves at once, so the next move compares against what is really stored. */
export function turnAccountRecorder(session: HarnessSession, persist: () => Promise<void>): (to: AiHarnessAccount) => Promise<void> {
  let recorded = session.accountId;
  return async (to) => {
    if (to.id === recorded) return;
    const stored = (await readState()).sessions.find((item) => item.id === session.id);
    if (stored && stored.accountId !== recorded) return;
    session.accountId = to.id;
    recorded = to.id;
    await persist();
  };
}

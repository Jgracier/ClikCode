/** Select a usable account for a turn or a failover. */
import { accountCanTakeTurn, accountQuotaSpent, usageReadingIsCurrent, vendorWindows } from '../harness/accounts/usage-reading.js';
import { learnedReading } from '../harness/accounts/learned-usage.js';
import { isDirectModelProvider } from '../runtime/lazy-bridge.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { usageExhaustedMessage } from './usage-exhausted.js';
import chalk from 'chalk';
import { accountSwitchNotice, accountVerification, verificationNotice, type AccountFailureKind } from './failover.js';
import { recordQuotaRefusal } from './account-outcome.js';
import { isTurnCancelled, turnCancelledError } from '../agent/cancellation.js';
import { readState } from '../session/state/read.js';
import type { TurnObserver } from './observer.js';

/** Credentials do not select a transport by themselves: tool-style providers
 * use their CLI even when the account supplies an API key. */
export function turnBackendForAccount(account: AiHarnessAccount): 'vendor' | 'direct' {
  return account.authKind === 'api-key' && isDirectModelProvider(account.provider) ? 'direct' : 'vendor';
}

export function matchesDirectTurnModel(account: AiHarnessAccount, model: string): boolean {
  return turnBackendForAccount(account) === 'direct' && account.models.includes(model);
}

/** A vendor-CLI turn. An API key on a direct model provider is the other backend. */
export function matchesVendorTurn(account: AiHarnessAccount): boolean {
  return turnBackendForAccount(account) === 'vendor';
}

/** Whether any account of this provider, on this transport, can still take
 * the turn by the one rule. "All accounts exhausted" -- and the offer to
 * resume on another provider that follows it -- is only true when not.
 * An account this turn already tried does not count until the reset its
 * refusal named has passed: its stored windows can still show room. */
export function providerHasAccountForTurn(
  state: HarnessState, provider: string, matchesTransport: (candidate: AiHarnessAccount) => boolean, now: number = Date.now(),
  attempted?: ReadonlyMap<string, number>,
): boolean {
  return state.accounts.some((candidate) => candidate.provider === provider && matchesTransport(candidate) && accountCanTakeTurn(candidate, now)
    && !(attempted?.has(candidate.id) && !resetPassedSince(candidate, attempted.get(candidate.id)!, now)));
}

/** Room left on this account, in percent: the tightest window that can stop
 * it, from the vendor's reading while it is current -- or, for a harness that
 * reports none, from what its refusals have taught. Undefined when neither
 * says. Ranking only: whether the account may be tried at all is
 * accountQuotaSpent, and a learned figure never decides that. */
export function reportedRoom(state: HarnessState, account: AiHarnessAccount, now: number = Date.now()): number | undefined {
  const vendor = vendorWindows(account).filter((window) => !window.advisory);
  const windows = vendor.length ? vendor : learnedReading(state, account, now)?.windows ?? [];
  if (!windows.length || !usageReadingIsCurrent({ windows }, now)) return undefined;
  return Math.min(...windows.map((window) => Math.max(0, 100 - window.usedPct)));
}

/** Whether a reset this account named came after the turn tried it and has
 * passed since. A `quotaRetryAt` already past when it was tried is a stale
 * mark, not news: honouring it walked two throttled accounts A, B, A, ...
 * forever. */
function resetPassedSince(account: AiHarnessAccount, triedAt: number, now: number): boolean {
  const at = account.quotaRetryAt ? Date.parse(account.quotaRetryAt) : Number.NaN;
  return Number.isFinite(at) && at > triedAt && at <= now;
}

/** The account a failover moves to: same provider and transport, signed in,
 * not held for verification, not out of quota, not already tried -- most
 * reported room first, an account with no figure after those. Reads stored
 * state only (a live probe per candidate is what made a switch take minutes)
 * and writes nothing. */
export function nextUsableFailoverAccount(
  state: HarnessState,
  current: AiHarnessAccount,
  matchesTransport: (candidate: AiHarnessAccount) => boolean,
  /** Accounts this turn already tried, and when. */
  attempted: ReadonlyMap<string, number>,
  now: number = Date.now(),
): AiHarnessAccount | undefined {
  const room = (account: AiHarnessAccount): number => reportedRoom(state, account, now) ?? -1;
  return state.accounts
    // One this turn already tried is tried again only once the reset its
    // refusal named has passed: "All accounts exhausted" was said a minute
    // after the first account had come back.
    .filter((candidate) => candidate.id !== current.id && (!attempted.has(candidate.id) || resetPassedSince(candidate, attempted.get(candidate.id)!, now))
      && candidate.provider === current.provider && matchesTransport(candidate) && accountCanTakeTurn(candidate, now))
    .sort((left, right) => room(right) - room(left))[0];
}

/** The account a turn starts on. Stored usage only orders the accounts:
 * one it shows spent gives way to one that shows room. It never refuses the
 * turn -- with nothing better, the vendor is asked and its answer decides.
 * A stored hold can be stale in any direction (a reset rounded to the hour,
 * one that went unread, another device), and a refused attempt costs a few
 * seconds where a wrong local refusal cost every message until the record
 * caught up. */
export function initialAccountChoice(
  state: HarnessState,
  current: AiHarnessAccount,
  matchesBackend: (candidate: AiHarnessAccount) => boolean,
  attempted: Map<string, number>,
): { kind: 'continue' } | { kind: 'switch'; account: AiHarnessAccount } {
  if (!accountQuotaSpent(current)) return { kind: 'continue' };
  const fallback = nextUsableFailoverAccount(state, current, matchesBackend, new Map([...attempted, [current.id, Date.now()]]));
  if (!fallback) return { kind: 'continue' };
  attempted.set(current.id, Date.now());
  return { kind: 'switch', account: fallback };
}

/** Report exhaustion only when no account on this backend can still run. */
export function terminalFailoverError(input: {
  state: HarnessState;
  current: AiHarnessAccount;
  matchesBackend: (candidate: AiHarnessAccount) => boolean;
  exhaustedAny: boolean;
  lastFailure: unknown;
  lastOtherFailure?: unknown;
  /** Accounts this turn already tried, and when. The one that just refused
   * is not "an account that can still run" while its stored windows lag. */
  attempted?: ReadonlyMap<string, number>;
}): unknown {
  const { state, current, matchesBackend, exhaustedAny, lastFailure, lastOtherFailure, attempted } = input;
  if (!exhaustedAny) return lastFailure;
  if (providerHasAccountForTurn(state, current.provider, matchesBackend, Date.now(), attempted)) return lastOtherFailure ?? lastFailure;
  return new Error(usageExhaustedMessage());
}

/** Copy the eligibility fields a probe or another chat wrote, onto the
 * accounts this turn is holding. A turn keeps the copy it read at the start,
 * so a window that came back during the turn was still "spent" here and the
 * usage refusal ended as an error instead of moving. The account that just
 * refused is left as this turn recorded it. */
async function adoptStoredEligibility(state: HarnessState, exceptId?: string): Promise<void> {
  const stored = await readState({ transcripts: [] });
  const byId = new Map(stored.accounts.map((account) => [account.id, account]));
  for (const account of state.accounts) {
    if (account.id === exceptId) continue;
    const fresh = byId.get(account.id);
    if (!fresh) continue;
    account.status = fresh.status;
    account.verification = fresh.verification;
    account.quotaState = fresh.quotaState;
    account.quotaExhaustedAt = fresh.quotaExhaustedAt;
    account.quotaRetryAt = fresh.quotaRetryAt;
    account.usage = fresh.usage;
    account.plan = fresh.plan;
  }
}

/** Where a turn stands across its failed attempts. */
export interface FailoverTally {
  /** Accounts already tried, and when: each at most once, unless a reset it
   * named since has passed, so a broken harness cannot cycle. */
  attempted: Map<string, number>;
  /** Whether any account actually ran out, as opposed to failing some other
   * way. Decides whether "Usage Exhausted" is the truth at the end. */
  exhaustedAny: boolean;
  /** The last failure that was not running out, for when running out is not
   * the whole story. */
  lastOtherFailure?: unknown;
}

/** Failures another account can fix. */
const ACCOUNT_FAILURES: ReadonlySet<AccountFailureKind> = new Set(['quota-exhausted', 'temporarily-throttled', 'authentication-required', 'account-ineligible']);

/** The one failover step, after an attempt failed on `account`: the account
 * that takes the turn next, or the error that ends it.
 *
 * Shared by both account backends (vendor-turn.ts, direct-turn.ts), because
 * two copies drifted: the direct copy had no cancel guard, so Esc aborted the
 * request, the abort was classed "other", and the turn retried on the next
 * account with the already-aborted signal -- until every account had been
 * walked.
 *
 * Failover moves a turn to another account only for what is the ACCOUNT's:
 * usage spent, a rate limit, a sign-in gone, a plan that does not cover the
 * model. Anything else -- a crash, an unrecognised error, a rejected request,
 * a stall -- would happen on every account alike, and moving on only started
 * the request over somewhere else: ClikCode once sent --effort to Antigravity
 * and walked seven accounts collecting the same refusal, and a Grok turn
 * walked four accounts in an hour, retold onto a fresh thread at each, until
 * the model only repeated the retelling. Those are surfaced as the vendor
 * worded them (the caller has already retried once in place). Only a quota
 * refusal marks the account spent. */
export async function accountAfterFailure(input: {
  state: HarnessState;
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
  const { state, account, failure, kind, tally } = input;
  // Stopped, not failed: whatever the attempt died of, it died because it was
  // cancelled, and no other account is owed the request.
  if (input.signal?.aborted || isTurnCancelled(failure)) {
    throw turnCancelledError();
  }
  if (kind === 'authentication-required') account.status = 'needs_login';
  if (!ACCOUNT_FAILURES.has(kind) || (failure as { reason?: unknown } | undefined)?.reason === 'idle-timeout') {
    await input.persist();
    throw failure;
  }
  // Tried before the refusal is recorded, so the reset it names is after.
  tally.attempted.set(account.id, Date.now());
  if (kind === 'quota-exhausted') {
    recordQuotaRefusal(state, account, failure);
    tally.exhaustedAny = true;
  } else tally.lastOtherFailure = failure;
  const verification = kind === 'account-ineligible' ? accountVerification(failure) : undefined;
  if (verification) {
    account.verification = { ...verification, at: new Date().toISOString() };
    input.notice?.(verificationNotice(verification));
  }
  await input.persist();
  // Other chats and the usage probe write the account record this turn is
  // not holding. Re-read them after the refusal is saved, so an account that
  // has usage now is the one the turn moves to.
  await adoptStoredEligibility(state, account.id);
  const fallback = nextUsableFailoverAccount(state, account, input.matchesBackend, tally.attempted);
  if (fallback) return fallback;
  throw terminalFailoverError({
    state, current: account, matchesBackend: input.matchesBackend,
    exhaustedAny: tally.exhaustedAny, lastFailure: failure, lastOtherFailure: tally.lastOtherFailure,
    attempted: tally.attempted,
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
    const stored = (await readState({ transcripts: [] })).sessions.find((item) => item.id === session.id);
    if (stored && stored.accountId !== recorded) return;
    session.accountId = to.id;
    recorded = to.id;
    await persist();
  };
}

/** A turn's account and how it moved, for either account backend
 * (vendor-turn.ts, direct-turn.ts): the choice it starts on, the step after a
 * failed attempt, and the switch itself -- said before the retry (it happens
 * inside one await chain and would otherwise look instantaneous) and with the
 * reason, so a crash is not called a spent plan. The account itself stays the
 * caller's variable (`current`/`adopt`). */
export function turnAccounts(input: {
  state: HarnessState;
  session: HarnessSession;
  prompter?: TurnObserver;
  matchesBackend: (candidate: AiHarnessAccount) => boolean;
  /** Saves what a step recorded. */
  persist: () => Promise<void>;
  current: () => AiHarnessAccount;
  adopt: (account: AiHarnessAccount) => void;
  /** Runs before the account changes (a vendor closes its live process). */
  beforeSwitch?: () => Promise<void>;
}) {
  const { state, session, prompter, matchesBackend, persist } = input;
  const tally: FailoverTally = { attempted: new Map(), exhaustedAny: false };
  const recordAccount = turnAccountRecorder(session, persist);
  let switchedFrom: string | undefined;
  /** Why the turn left that account: the failure it met there. */
  let switchReason: AccountFailureKind = 'quota-exhausted';
  const switchTo = async (to: AiHarnessAccount, why: AccountFailureKind): Promise<void> => {
    // The status line says it while it happens; the band names the account
    // the turn is on. A line in the conversation per switch was noise.
    prompter?.phase(accountSwitchNotice(why, to.label));
    await input.beforeSwitch?.();
    switchedFrom = input.current().label;
    switchReason = why;
    input.adopt(to);
    await recordAccount(to);
  };
  return {
    recordAccount,
    switchTo,
    /** Moves off a spent account before the first attempt; true when it did.
     * `carry` runs first, while the account is still the old one. */
    async start(carry?: (to: AiHarnessAccount) => Promise<void>): Promise<boolean> {
      await adoptStoredEligibility(state);
      const initial = initialAccountChoice(state, input.current(), matchesBackend, tally.attempted);
      if (initial.kind !== 'switch') return false;
      await carry?.(initial.account);
      await switchTo(initial.account, 'quota-exhausted');
      return true;
    },
    /** accountAfterFailure for the current account. */
    after: (failure: unknown, kind: AccountFailureKind, signal?: AbortSignal): Promise<AiHarnessAccount> => accountAfterFailure({
      state, account: input.current(), failure, kind, signal, matchesBackend, tally, persist,
      notice: (message) => prompter?.activity(chalk.yellow(message)),
    }),
    /** What the turn's output says about a move, when there was one. */
    switched: (): { accountSwitchedFrom?: string; reason?: AccountFailureKind } =>
      switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: switchReason } : {},
  };
}

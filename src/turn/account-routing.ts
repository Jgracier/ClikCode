/** Select a usable account for a turn or a failover. */
import { quiet } from '../runtime/lifecycle-log.js';
import { USAGE_RECHECK_MS, accountCanTakeTurn, quotaRefusalHolds, usageReadingIsCurrent, vendorWindows } from '../harness/accounts/usage-reading.js';
import { isDirectModelProvider } from '../runtime/lazy-bridge.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { usageExhaustedMessage } from './usage-exhausted.js';
import chalk from 'chalk';
import { accountSwitchNotice, accountVerification, verificationNotice, type AccountFailureKind, type AccountMoveReason } from './failover.js';
import { recordQuotaRefusal } from './account-outcome.js';
import { earlyMoveTarget } from './account-burn.js';
import { isTurnCancelled, turnCancelledError } from '../agent/cancellation.js';
import { readState } from '../session/state/read.js';
import { loadIndex } from '../session/state/index-file.js';
import { refreshAccount } from '../session/state/merge.js';
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
 * it, from the vendor's reading while it is current. Undefined when the
 * vendor reports none. Ranking only: whether the account may be tried at all
 * is accountQuotaSpent. */
export function reportedRoom(account: AiHarnessAccount, now: number = Date.now()): number | undefined {
  const windows = vendorWindows(account).filter((window) => !window.advisory);
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

/** When the vendor last said this account's usage: a reading it answered or a
 * refusal. An ask that failed confirms nothing (Codex's free plan answers with
 * no windows, and a carried 5-day-old figure kept looking fresh). */
function confirmedAt(account: AiHarnessAccount): number {
  return Math.max(
    account.usage && !account.usage.failed ? Date.parse(account.usage.at) || Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY,
    Date.parse(account.quotaExhaustedAt ?? '') || Number.NEGATIVE_INFINITY,
  );
}

/** The account a failover moves to: same provider and transport, signed in,
 * not held for verification. First the accounts that can take a turn and were
 * not tried yet (one already tried only once the reset its refusal named has
 * passed: "All accounts exhausted" was said a minute after the first account
 * had come back), most reported room first, one with no figure after those.
 * Then, with none of those, one held as spent that no one has confirmed within
 * USAGE_RECHECK_MS, the longest unconfirmed first: it gets a real attempt
 * rather than being written off on an old record, and a refusal re-stamps it,
 * so repeated sends try it at most once per interval. Reads `state` only (a
 * live probe per candidate is what made a switch take minutes) and writes
 * nothing. */
export function nextUsableFailoverAccount(
  state: HarnessState,
  current: AiHarnessAccount,
  matchesTransport: (candidate: AiHarnessAccount) => boolean,
  /** Accounts this turn already tried, and when. */
  attempted: ReadonlyMap<string, number>,
  now: number = Date.now(),
): AiHarnessAccount | undefined {
  const usable = (candidate: AiHarnessAccount): boolean => accountCanTakeTurn(candidate, now)
    && (!attempted.has(candidate.id) || resetPassedSince(candidate, attempted.get(candidate.id)!, now));
  const unconfirmed = (candidate: AiHarnessAccount): boolean => !attempted.has(candidate.id)
    && candidate.status === 'ready' && !candidate.verification && now - confirmedAt(candidate) >= USAGE_RECHECK_MS;
  const rank = (account: AiHarnessAccount): [tier: number, order: number] => usable(account)
    ? [0, -(reportedRoom(account, now) ?? -1)]
    : [1, confirmedAt(account)];
  return state.accounts
    .filter((candidate) => candidate.id !== current.id && candidate.provider === current.provider && matchesTransport(candidate)
      && (usable(candidate) || unconfirmed(candidate)))
    .map((account) => ({ account, rank: rank(account) }))
    .sort((left, right) => left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1])[0]?.account;
}

/** The account a turn starts on, and why it moved if it did.
 *
 * A chat leaves its own account before a turn when the vendor refused that account and nothing since
 * says otherwise -- or, earlier, when its usage reading shows that what the turn is about to do will
 * not fit and another account plainly has the room (account-burn.ts: the rule, the margin measured
 * from the account's own burn, and why a reading that is not current never moves a chat: readings
 * lag -- Claude's /usage said "weekly 100%" after the user reset the limit). If a reading was right
 * and no move was made, the cost is one refused attempt and the usual failover. With nothing better
 * to move to, the turn goes to the vendor either way. `turns`: how many turns' worth of usage the
 * turn is about to spend (more than one when it starts agents in parallel). */
export function initialAccountChoice(
  state: HarnessState,
  current: AiHarnessAccount,
  matchesBackend: (candidate: AiHarnessAccount) => boolean,
  attempted: Map<string, number>,
  options: { now?: number; turns?: number } = {},
): { kind: 'continue' } | { kind: 'switch'; account: AiHarnessAccount; reason: 'quota-exhausted' | 'low-room' } {
  const now = options.now ?? Date.now();
  const refused = quotaRefusalHolds(current, now);
  const fallback = nextUsableFailoverAccount(state, current, matchesBackend, new Map([...attempted, [current.id, now]]), now);
  if (!fallback) return { kind: 'continue' };
  const early = !refused && accountCanTakeTurn(fallback, now)
    && earlyMoveTarget(current, [fallback], state.invocations, { now, turns: options.turns ?? 1 }) !== undefined;
  if (!refused && !early) return { kind: 'continue' };
  attempted.set(current.id, now);
  return { kind: 'switch', account: fallback, reason: refused ? 'quota-exhausted' : 'low-room' };
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

/** The turn's accounts as stored now: a probe or another chat may have marked
 * one spent, signed one in or read room on one since this turn read its copy,
 * and a turn that chose from that copy moved to an account just marked spent,
 * or ended a usage refusal as an error with a window back. Read to choose only
 * (the cached index, nothing cloned): the turn's copy is not changed, so its
 * next write cannot store these fields as its own. `own`: the account that just
 * refused, as this turn recorded it. */
async function storedView(state: HarnessState, own?: AiHarnessAccount): Promise<HarnessState> {
  const stored = new Map(((await loadIndex().catch(quiet('turn/account-routing')))?.accounts ?? []).map((account) => [account.id, account]));
  return { ...state, accounts: state.accounts.map((account) => account === own ? account : stored.get(account.id) ?? account) };
}

/** The turn's own record of `account` (chosen from storedView), brought up to
 * date with it: as if just read, so not stored as a change of this turn's. */
function chosen(state: HarnessState, account: AiHarnessAccount): AiHarnessAccount {
  const own = state.accounts.find((item) => item.id === account.id);
  if (!own) return account;
  if (own !== account) refreshAccount(state, account);
  return own;
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
  if (!ACCOUNT_FAILURES.has(kind)) {
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
  // Chosen from the accounts as stored after the refusal is saved.
  const view = await storedView(state, account);
  const fallback = nextUsableFailoverAccount(view, account, input.matchesBackend, tally.attempted);
  if (fallback) return chosen(state, fallback);
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
export function turnAccountRecorder(session: HarnessSession, persist: () => Promise<void>):
  (to: AiHarnessAccount, save?: boolean) => Promise<void> {
  let recorded = session.accountId;
  return async (to, save = true) => {
    if (to.id === recorded) return;
    const stored = (await readState({ transcripts: [] })).sessions.find((item) => item.id === session.id);
    if (stored && stored.accountId !== recorded) return;
    session.accountId = to.id;
    recorded = to.id;
    if (save) await persist();
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
  let switchReason: AccountMoveReason = 'quota-exhausted';
  const switchTo = async (to: AiHarnessAccount, why: AccountMoveReason): Promise<void> => {
    // The status line says it while it happens, and names the account the
    // turn is on after; the turn's answer keeps it as a line in the
    // conversation (TranscriptMessage.accountSwitch), drawn at its end.
    prompter?.phase(accountSwitchNotice(why, to.label));
    // Closing the old account's process and recording the new choice are
    // independent after its thread has been carried. Overlap them: waiting
    // for shutdown before touching the index added its full latency to each
    // account switch.
    const closing = input.beforeSwitch?.();
    switchedFrom = input.current().label;
    switchReason = why;
    // From the account the turn first ran on: two switches are one move.
    const first = session.pendingTurn?.accountSwitch?.from ?? switchedFrom;
    if (session.pendingTurn) session.pendingTurn.accountSwitch = { from: first, to: to.label, reason: why };
    input.adopt(to);
    // Record the account and the pending turn's switch together. A separate
    // save here used to write the same state twice on every failover.
    await Promise.all([closing, recordAccount(to, false)]);
    await persist();
  };
  return {
    recordAccount,
    switchTo,
    /** Moves off a spent account before the first attempt; true when it did.
     * `carry` runs first, while the account is still the old one. `turns`: see initialAccountChoice. */
    async start(carry?: (to: AiHarnessAccount) => Promise<void>, turns?: number): Promise<boolean> {
      const view = await storedView(state);
      const current = input.current();
      const stored = view.accounts.find((item) => item.id === current.id) ?? current;
      const initial = initialAccountChoice(view, stored, matchesBackend, tally.attempted, turns === undefined ? {} : { turns });
      if (initial.kind !== 'switch') {
        chosen(state, stored);
        return false;
      }
      const to = chosen(state, initial.account);
      await carry?.(to);
      await switchTo(to, initial.reason);
      return true;
    },
    /** accountAfterFailure for the current account. */
    after: (failure: unknown, kind: AccountFailureKind, signal?: AbortSignal): Promise<AiHarnessAccount> => accountAfterFailure({
      state, account: input.current(), failure, kind, signal, matchesBackend, tally, persist,
      notice: (message) => prompter?.activity(chalk.yellow(message)),
    }),
    /** What the turn's output says about a move, when there was one. */
    switched: (): { accountSwitchedFrom?: string; reason?: AccountMoveReason } =>
      switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: switchReason } : {},
  };
}

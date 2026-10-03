/** Select a usable account for a turn or a failover. */
import { accountCanTakeTurn, accountQuotaSpent, usageReadingIsCurrent, vendorWindows } from '../harness/accounts/usage-reading.js';
import { isDirectModelProvider } from '../runtime/lazy-bridge.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { usageExhaustedMessage } from './usage-exhausted.js';
import chalk from 'chalk';
import { accountSwitchNotice, accountSwitchPhase, accountVerification, verificationNotice, type AccountFailureKind } from './failover.js';
import { recordQuotaRefusal } from './account-outcome.js';
import { isTurnCancelled, turnCancelledError } from '../agent/cancellation.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { TurnObserver } from './observer.js';

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

/** Room the vendor last reported on this account, in percent: the tightest
 * window that can stop it, from a reading still current. Undefined when it
 * reported none. Ranking only -- whether the account may be tried at all is
 * accountQuotaSpent, and a turn since the reading does not change either:
 * the figure is old, not wrong, and only the vendor says an account is out. */
export function reportedRoom(account: AiHarnessAccount, now: number = Date.now()): number | undefined {
  const windows = vendorWindows(account).filter((window) => !window.advisory);
  if (!windows.length || !usageReadingIsCurrent({ windows }, now)) return undefined;
  return Math.min(...windows.map((window) => Math.max(0, 100 - window.usedPct)));
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
  attempted: ReadonlySet<string>,
  now: number = Date.now(),
): AiHarnessAccount | undefined {
  const room = (account: AiHarnessAccount): number => reportedRoom(account, now) ?? -1;
  return state.accounts
    .filter((candidate) => candidate.id !== current.id && !attempted.has(candidate.id)
      && candidate.provider === current.provider && matchesTransport(candidate) && accountCanTakeTurn(candidate, now))
    .sort((left, right) => room(right) - room(left))[0];
}

/** Decide the first account from stored usage before starting a provider. */
export function initialAccountChoice(
  state: HarnessState,
  current: AiHarnessAccount,
  policy: HarnessSession['accountFailover'],
  matchesBackend: (candidate: AiHarnessAccount) => boolean,
  attempted: Set<string>,
): { kind: 'continue' } | { kind: 'switch'; account: AiHarnessAccount } | { kind: 'exhausted'; error: Error } {
  if (policy !== 'on-quota-exhausted' || !accountQuotaSpent(current)) return { kind: 'continue' };
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
 * the same refusal), so it is surfaced as the vendor worded it. Nor is a
 * stall: a vendor that went quiet for the idle budget says nothing about the
 * account, and moving on only started the request over somewhere else. */
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
  if (kind === 'request-invalid' || (failure as { reason?: unknown } | undefined)?.reason === 'idle-timeout') {
    await input.persist();
    throw failure;
  }
  if (kind === 'quota-exhausted') {
    recordQuotaRefusal(account, failure);
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
  const tally: FailoverTally = { attempted: new Set(), exhaustedAny: false };
  const recordAccount = turnAccountRecorder(session, persist);
  let switchedFrom: string | undefined;
  /** Why the turn left that account: the failure it met there. */
  let switchReason: AccountFailureKind = 'quota-exhausted';
  const switchTo = async (to: AiHarnessAccount, why: AccountFailureKind): Promise<void> => {
    prompter?.activity(chalk.yellow(accountSwitchNotice(why, to.label)));
    prompter?.phase(accountSwitchPhase(to.label));
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
      const initial = initialAccountChoice(state, input.current(), session.accountFailover, matchesBackend, tally.attempted);
      if (initial.kind === 'exhausted') { await writeState(state); throw initial.error; }
      if (initial.kind !== 'switch') return false;
      await carry?.(initial.account);
      await switchTo(initial.account, 'quota-exhausted');
      return true;
    },
    /** accountAfterFailure for the current account. */
    after: (failure: unknown, kind: AccountFailureKind, signal?: AbortSignal): Promise<AiHarnessAccount> => accountAfterFailure({
      state, session, account: input.current(), failure, kind, signal, matchesBackend, tally, persist,
      notice: (message) => prompter?.activity(chalk.yellow(message)),
    }),
    /** What the turn's output says about a move, when there was one. */
    switched: (): { accountSwitchedFrom?: string; reason?: AccountFailureKind } =>
      switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: switchReason } : {},
  };
}

/** Select a usable account for a turn or a failover. */
import { noteStoredQuota } from './account-switch.js';
import { accountCanTakeTurn } from '../harness/accounts/usage-reading.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';

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

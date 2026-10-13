/** What a turn's outcome records on its account. */
import { clearQuotaMark, markQuotaExhausted, vendorWindows, windowKey, windowSpent } from '../harness/accounts/usage-reading.js';
import { quotaRetryHint, quotaRollingWindowMs } from './failover.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';

/** A turn the vendor allowed. */
export function recordSuccessfulAccountTurn(account: AiHarnessAccount): void {
  // The vendor served this turn: any window its reading calls spent is not.
  const spent = vendorWindows(account).filter(windowSpent).map(windowKey);
  if (spent.length) account.disprovenWindows = [...new Set([...account.disprovenWindows ?? [], ...spent])];
  clearQuotaMark(account);
  account.verification = undefined;
}

/** A free-plan refusal can arrive before the billing probe has named the
 * plan. Without that, the refusal is not learned and the status line never
 * leaves "Free plan". */
function noteFreePlan(account: AiHarnessAccount, failure: unknown): void {
  if (account.plan) return;
  const carried = (failure ?? {}) as { stderrTail?: unknown; message?: unknown };
  const text = [carried.stderrTail, carried.message].filter((part): part is string => typeof part === 'string').join('\n');
  if (/free-usage-exhausted/i.test(text)) account.plan = { name: 'Free' };
}

/** A refusal holds until the vendor says it ends: the refusal's own "resets
 * in", else the reset of a window its last reading showed spent, else the
 * rolling window's length the refusal named. With none of those, the mark
 * uses the default (see quotaMarkExpiresAt) and the account is tried again
 * on a later turn. */
export function recordQuotaRefusal(state: HarnessState, account: AiHarnessAccount, failure: unknown, now = Date.now()): void {
  // A refusal makes the vendor's readings credible again.
  account.disprovenWindows = undefined;
  noteFreePlan(account, failure);
  const named = quotaRetryHint(failure, now);
  // A rolling window names its length, not a reset instant: it is the last resort.
  const windowMs = quotaRollingWindowMs(failure);
  const exact = windowMs ? undefined : named;
  const spentReset = vendorWindows(account)
    .filter((window) => windowSpent(window) && window.resetsAt !== undefined && Date.parse(window.resetsAt) > now)
    .map((window) => window.resetsAt!).sort().at(-1);
  markQuotaExhausted(account, now, exact ?? spentReset ?? named);
}

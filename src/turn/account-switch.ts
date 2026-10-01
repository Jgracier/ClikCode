/** Which account a failover may try, using only usage that is still true.
 *
 * A live probe here is what made a switch take minutes: Claude's check is a
 * real turn, Codex starts an app-server, and both ran once per candidate
 * before the next message was sent. Nothing in this file spawns a vendor
 * process.
 *
 * A positive "percent left" goes stale the moment anything spends more, so
 * it is used only when no later turn is already recorded for that account.
 * The moment a newer invocation exists, the percent is dropped and the
 * account is treated as unknown rather than preferred. Emptiness is the
 * other way around: a refusal or a spent window stays true until that
 * window's own reset, and a later turn cannot refill it. An account with
 * no current figure is still tried, and it never outranks one whose figure
 * is still true and shows room left. */
import type { AiHarnessAccount } from '../harness/definition.js';
import { learnedUsageReading } from '../harness/accounts/usage-learning.js';
import { NATIVE_USAGE_PROBES } from '../harness/accounts/usage-probes.js';
import { NATIVE_STREAM_USAGE_READINGS } from '../harness/accounts/stream-usage.js';
import { accountQuotaSpent, markQuotaExhausted, settleQuotaMark, usageReadingIsCurrent, windowSpent, type AccountUsageReading, type UsageWindow } from '../harness/accounts/usage-reading.js';
import { localHarnessForProvider } from '../runtime/lazy-bridge.js';
import type { HarnessState } from '../session/model.js';
import { usageLabelRemainingPercent } from './failover.js';

function storedWindows(account: AiHarnessAccount): UsageWindow[] {
  return (account.usage as AccountUsageReading | undefined)?.windows ?? [];
}

/** A saved percent left is already behind a turn that happened after it. */
function positiveReadingIsStale(account: AiHarnessAccount, state: HarnessState): boolean {
  const at = Date.parse(account.usage?.at ?? '');
  if (!Number.isFinite(at)) return true;
  return state.invocations.some((invocation) => {
    if (invocation.accountId !== account.id) return false;
    const when = Date.parse(invocation.at);
    return Number.isFinite(when) && when > at;
  });
}

function publishesLiveUsage(account: AiHarnessAccount): boolean {
  let command: string | undefined;
  try { command = localHarnessForProvider(account.provider)?.command; } catch { command = undefined; }
  if (!command) return false;
  return NATIVE_USAGE_PROBES[command] !== undefined || NATIVE_STREAM_USAGE_READINGS[command] !== undefined;
}

/** Remaining percent already known for this account.
 *
 * `0` means do not start a turn on it. `undefined` means nothing is
 * displayed, so it may be tried. A positive number is headroom to prefer.
 * Clears `quotaState` when the account's quota has come back. */
export function noteStoredQuota(account: AiHarnessAccount, state: HarnessState, now = Date.now()): number | undefined {
  // The same rule every screen uses: a mark the vendor's reset, a later
  // reading or its own expiry has overtaken is cleared here, and a spent
  // window or a live mark means do not start a turn.
  settleQuotaMark(account, now);
  if (accountQuotaSpent(account, now)) {
    // A spent window is recorded as a mark too, expiring at that window's
    // reset, so the stored record says what the reading does.
    if (account.quotaState !== 'exhausted') {
      const resets = storedWindows(account).filter(windowSpent).map((window) => window.resetsAt);
      markQuotaExhausted(account, now, resets.includes(undefined) ? undefined : (resets as string[]).sort().at(-1));
    }
    return 0;
  }

  const windows = storedWindows(account);
  const current = windows.length > 0 && usageReadingIsCurrent({ windows }, now) ? windows : undefined;
  if (current?.length && !positiveReadingIsStale(account, state)) {
    return Math.min(...current.map((window) => Math.max(0, 100 - window.usedPct)));
  }

  // Learned usage is recomputed from the invocations held right now, so it
  // is not a saved percent. A positive estimate is still only a lower bound
  // on the real limit — never something to prefer an account on. Zero is a
  // refusal the history already explains.
  if (!publishesLiveUsage(account)) {
    const reading = learnedUsageReading(account.usageLearning, state.invocations, account.id, now);
    if (usageLabelRemainingPercent(reading?.label) === 0) {
      // Recorded as a mark, expiring when the learned window rolls, so every
      // screen -- which cannot recompute the learned figure -- agrees.
      const resets = (reading?.windows ?? []).filter((window) => windowSpent(window) && window.resetsAt)
        .map((window) => window.resetsAt!).sort();
      markQuotaExhausted(account, now, resets.at(-1));
      return 0;
    }
  }
  return undefined;
}

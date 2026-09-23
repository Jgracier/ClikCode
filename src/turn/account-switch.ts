/** Which account a failover may try, using only usage already on hand.
 *
 * A live probe here is what made a switch take minutes: Claude's check is a
 * real turn, Codex starts an app-server, and both ran once per candidate
 * before the next message was sent. The figure the accounts list would
 * already show is enough. Nothing in this file spawns a vendor process.
 *
 * A recorded refusal wins over a saved "still has some left". That percent
 * goes stale the moment another chat spends the rest, and trusting it put
 * the empty account first. The refusal sticks until a spent window's own
 * reset time has passed. An account with no figure is still tried — there
 * is nothing to skip it on — and it never outranks one whose figure shows
 * room left. */
import type { AiHarnessAccount } from '../harness/definition.js';
import { learnedUsageReading } from '../harness/accounts/usage-learning.js';
import { NATIVE_USAGE_PROBES } from '../harness/accounts/usage-probes.js';
import { NATIVE_STREAM_USAGE_READINGS } from '../harness/accounts/stream-usage.js';
import { usageReadingIsCurrent, type AccountUsageReading, type UsageWindow } from '../harness/accounts/usage-reading.js';
import { localHarnessForProvider } from '../runtime/lazy-bridge.js';
import type { HarnessState } from '../session/model.js';
import { usageLabelRemainingPercent } from './failover.js';

function storedWindows(account: AiHarnessAccount): UsageWindow[] {
  return (account.usage as AccountUsageReading | undefined)?.windows ?? [];
}

/** The refusal is obsolete only when every window that was actually spent
 * has reached the reset time the vendor reported. No such window means
 * there is no evidence the quota came back, so the refusal stands. */
function refusalHasReset(account: AiHarnessAccount, now: number): boolean {
  if (account.quotaState !== 'exhausted') return false;
  const spent = storedWindows(account).filter((window) => window.usedPct >= 100);
  if (!spent.length) return false;
  return spent.every((window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now);
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
 * Mutates `quotaState` when a stored reading or a reset decides it. */
export function noteStoredQuota(account: AiHarnessAccount, state: HarnessState, now = Date.now()): number | undefined {
  if (refusalHasReset(account, now)) {
    account.quotaState = 'available';
    account.quotaRetryAt = undefined;
  }
  if (account.quotaState === 'exhausted') return 0;

  const windows = storedWindows(account);
  const current = windows.length > 0 && usageReadingIsCurrent({ windows }, now) ? windows : undefined;
  if (current?.some((window) => window.usedPct >= 100)) {
    account.quotaState = 'exhausted';
    account.quotaRetryAt = undefined;
    return 0;
  }
  if (current?.length) {
    return Math.min(...current.map((window) => Math.max(0, 100 - window.usedPct)));
  }

  if (!publishesLiveUsage(account)) {
    const learned = usageLabelRemainingPercent(
      learnedUsageReading(account.usageLearning, state.invocations, account.id, now)?.label,
    );
    if (learned === 0) {
      account.quotaState = 'exhausted';
      account.quotaRetryAt = undefined;
      return 0;
    }
    if (learned !== undefined) return learned;
  }

  // A percent with no window behind it cannot say when it stops being true,
  // so a positive one is ignored. Zero is still a reason not to try.
  if (!windows.length && account.usage?.failed !== true) {
    const label = usageLabelRemainingPercent(account.usage?.label);
    if (label === 0) {
      account.quotaState = 'exhausted';
      account.quotaRetryAt = undefined;
      return 0;
    }
  }
  return undefined;
}

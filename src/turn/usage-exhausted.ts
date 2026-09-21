/**
 * What a user is told when there is no quota left anywhere.
 *
 * Every harness reaches this the same way -- the last account it could try
 * refused the turn -- so every harness says the same thing, in the same words,
 * whatever the vendor's own error happened to be ("Payment Required",
 * "usage limit reached", "quota exhausted").
 *
 * Three forms, and only three:
 *
 *   Credits Exhausted
 *   Usage Exhausted · Resets 5:34PM
 *   Usage Exhausted · Resets 5:34PM Friday Sep 25
 *
 * A windowed plan comes back on its own, so the useful thing to say is when.
 * The date is included whenever the reset is not today -- decided by the
 * calendar day rather than the window's name, because a five-hour window that
 * rolls over after midnight needs its date as much as a weekly one does, and
 * "Resets 7:00PM" on a Monday is a lie about a window that returns Saturday.
 * A balance does not come back by itself, so there is nothing to wait for and
 * the wording says so instead.
 */
import type { AiHarnessAccount } from '../harness/types.js';
import type { AccountUsageReading, UsageWindow } from '../harness/account-data.js';

/** The soonest a spent window comes back, across every account that was
 * tried. Undefined when nothing on offer has a reset -- a spent balance, or a
 * vendor that never said. */
export function nextQuotaReset(
  accounts: readonly AiHarnessAccount[], now: number = Date.now(),
): Date | undefined {
  const resets = accounts
    .flatMap((account) => ((account.usage as AccountUsageReading | undefined)?.windows ?? []) as readonly UsageWindow[])
    .filter((window) => window.usedPct >= 100 && window.resetsAt !== undefined)
    .map((window) => Date.parse(window.resetsAt!))
    .filter((at) => Number.isFinite(at) && at > now)
    .sort((left, right) => left - right);
  return resets.length ? new Date(resets[0]!) : undefined;
}

/** `5:34PM`, or `5:34PM Friday Sep 25` when the reset is not today.
 *
 * The calendar day decides, not the window's name: a five-hour window that
 * rolls over after midnight needs its date as much as a weekly one does. */
export function quotaResetPhrase(reset: Date, now: number = Date.now()): string {
  const hours24 = reset.getHours();
  const time = `${hours24 % 12 || 12}:${reset.getMinutes().toString().padStart(2, '0')}${hours24 >= 12 ? 'PM' : 'AM'}`;
  const today = new Date(now);
  const sameDay = reset.getFullYear() === today.getFullYear()
    && reset.getMonth() === today.getMonth() && reset.getDate() === today.getDate();
  if (sameDay) return time;
  // Spelled out rather than taken from toLocaleDateString: that follows the
  // machine's locale, so the same reset reads "Sat 26 Sept" on one box and
  // "sam. 26 sept." on another, and a test written against either is wrong
  // somewhere else.
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][reset.getDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][reset.getMonth()];
  return `${time} ${weekday} ${month} ${reset.getDate()}`;
}

/** The one sentence shown when every account has been tried and none has
 * quota left. */
export function usageExhaustedMessage(
  accounts: readonly AiHarnessAccount[], now: number = Date.now(),
): string {
  const reset = nextQuotaReset(accounts, now);
  return reset ? `Usage Exhausted · Resets ${quotaResetPhrase(reset, now)}` : 'Credits Exhausted';
}

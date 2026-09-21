/** What a usage reading is -- a window, a remaining fraction, a reset time --
 * and how one is labelled, cached and judged current. No probing here. */

import { quotaResetPhrase } from '../../turn/usage-exhausted.js';
import type { AiHarnessAccount } from '../types.js';

/** One quota window as the vendor reported it. `usedPct` is the unrounded
 * percentage used (0..100+); the display label rounds, this does not, so
 * "99.6% used" is never mistaken for exhausted. */
export interface UsageWindow { name: string; usedPct: number; resetsAt?: string }

/** A usage reading: the structured windows plus the label the UI shows. */
export interface UsageReading { windows: UsageWindow[]; label?: string }

/** What is stored on `account.usage`. `windows` is persisted alongside the
 * typed fields; types.ts only declares `at`/`label`/`failed` today. */
export type AccountUsageReading = NonNullable<AiHarnessAccount['usage']> & { windows?: UsageWindow[] };

export interface UsageCacheEntry { at: number; label?: string; failed?: boolean; windows?: UsageWindow[] }

export const nativeUsageCache = new Map<string, UsageCacheEntry>();

/** One key for every path that produces or reads a usage figure. The stream
 * reader used `harness:nativeSessionId` while the probe used
 * `harness:profilePath`, so a free reading taken during a turn never satisfied
 * the next paint, which then paid for a probe anyway. Usage belongs to the
 * account; a session is only the fallback when there is no account. */
export function usageCacheKey(harnessCommand: string | undefined, accountId: string | null | undefined, nativeSessionId?: string): string {
  return accountId ? `${harnessCommand}:account:${accountId}` : `${harnessCommand}:session:${nativeSessionId ?? 'default'}`;
}

function resetTime(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Vendors publish epoch seconds; tolerate milliseconds.
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return undefined;
}

export function usageWindow(name: string, usedPct: unknown, resetsAt?: unknown): UsageWindow | undefined {
  if (typeof usedPct !== 'number' || !Number.isFinite(usedPct)) return undefined;
  const reset = resetTime(resetsAt);
  return { name, usedPct, ...(reset ? { resetsAt: reset } : {}) };
}

/** The single wording for a set of windows, whichever path produced them. */
export function usageReadingLabel(windows: readonly UsageWindow[]): string | undefined {
  const parts = windows.map((window) => `${window.name} ${Math.max(0, Math.min(100, Math.round(100 - window.usedPct)))}% left`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** "resets at 8:00PM", derived from the same vendor-reported `resetsAt` the
 * usage windows already carry -- not computed independently. Only speaks for
 * a window that is actually exhausted right now (matches accountIsExhausted's
 * `usedPct >= 100` threshold) and whose reset is still ahead of us; picks the
 * soonest one when more than one window is spent. */
export function usageResetLabel(windows: readonly UsageWindow[] | undefined, now: number = Date.now()): string | undefined {
  const exhausted = (windows ?? [])
    .filter((window): window is UsageWindow & { resetsAt: string } => window.usedPct >= 100 && window.resetsAt !== undefined && Date.parse(window.resetsAt) > now)
    .sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
  const next = exhausted[0];
  if (!next) return undefined;
  // Same phrasing as the message shown when every account is spent, so the
  // status line and the failure agree about when quota comes back -- and the
  // date appears whenever the reset is not today, which the time alone
  // misrepresents for a weekly window.
  return `Resets ${quotaResetPhrase(new Date(next.resetsAt), now)}`;
}

export function usageReading(windows: Array<UsageWindow | undefined>): UsageReading | undefined {
  const known = windows.filter((window): window is UsageWindow => Boolean(window));
  return known.length ? { windows: known, label: usageReadingLabel(known) } : undefined;
}

/** A figure describes a window; once that window has reset it describes
 * nothing, and showing it would present last period's quota as current. */
export function usageReadingIsCurrent(reading: { windows?: readonly UsageWindow[] } | undefined, now = Date.now()): boolean {
  return !(reading?.windows ?? []).some((window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now);
}

/** Is this account out of quota right now?
 *
 * Decided on the unrounded `usedPct >= 100`, never on the display string
 * ("0% left" is also what 99.6% used rounds to). Clears itself once every
 * exhausted window's `resetsAt` has passed, so an account is not left parked
 * after its quota came back. A failover-recorded `quotaState: 'exhausted'`
 * holds when no structured reading exists to say otherwise. */
export function accountIsExhausted(account: AiHarnessAccount, now: number = Date.now()): boolean {
  const windows = (account.usage as AccountUsageReading | undefined)?.windows ?? [];
  const spent = windows.filter((window) => window.usedPct >= 100);
  const stillSpent = spent.filter((window) => window.resetsAt === undefined || Date.parse(window.resetsAt) > now);
  if (stillSpent.length) return true;
  if (account.quotaState !== 'exhausted') return false;
  // Marked exhausted by a failed turn. A window that was spent and has since
  // reset is the trustworthy signal that the mark is obsolete.
  return spent.length === 0;
}
/** Two readings a minute, per ACCOUNT rather than per chat. The rate that
 * matters is accounts-in-use divided by this window: the reading now lives on
 * the account record, so any number of open chats on one login still costs one
 * request per window. It was per process before, which multiplied by every
 * open terminal and is what rate-limited the account out of reading its own
 * usage. The poll interval below divides this, so a tick actually probes
 * instead of landing inside the previous window. */

/** Vendors describe a quota window by its length, not by a name. 300 minutes
 * and 10080 minutes are the two everyone actually uses, and naming them the
 * way the endpoint probe already does keeps one wording for one account no
 * matter which path produced the reading. */
export function usageWindowName(minutes: number): string {
  if (minutes === 10_080) return 'weekly';
  if (minutes === 1_440) return 'daily';
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

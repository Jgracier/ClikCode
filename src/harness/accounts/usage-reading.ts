/** What a usage reading is -- a window, a remaining fraction, a reset time --
 * and how one is labelled, cached and judged current. No probing here. */

import { quotaResetPhrase } from '../../turn/usage-exhausted.js';
import type { AiHarnessAccount } from '../definition.js';

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

/** A window's name as it reads on screen: "Monthly", "Weekly", "5h". The
 * stored name stays as the vendor path wrote it; only the label changes. */
export function usageWindowTitle(name: string): string {
  return name ? name[0]!.toUpperCase() + name.slice(1) : name;
}

/** The single wording for a set of windows, whichever path produced them. */
function usageReadingLabel(windows: readonly UsageWindow[]): string | undefined {
  const parts = windows.map((window) => `${usageWindowTitle(window.name)} ${Math.max(0, Math.min(100, Math.round(100 - window.usedPct)))}% left`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** "resets at 8:00PM", derived from the same vendor-reported `resetsAt` the
 * usage windows already carry -- not computed independently. Only speaks for
 * a window that is actually exhausted right now (matches accountQuotaSpent's
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

/** How long a quota refusal is believed when nothing says when it ends.
 *
 * Five hours is the shortest window the subscription vendors actually use
 * (Claude's and Codex's rolling window; Antigravity's Pro refresh), so it is
 * the soonest a refused account can plausibly have room again. Guessing short
 * is cheap: the account is tried once, refuses once, and is marked again --
 * with the vendor's own "resets in" hint when it gives one. Guessing long is
 * what left eight Antigravity accounts parked for days after their quota came
 * back, because nothing re-reads a vendor that publishes no usage. */
export const QUOTA_MARK_DEFAULT_MS = 5 * 60 * 60 * 1000;

/** When the refusal was recorded. Marks written before `quotaExhaustedAt`
 * existed are dated by the refusal the usage learner stored with them --
 * recordRefused runs at the same moment the mark is set. */
export function quotaMarkedAt(account: AiHarnessAccount): number | undefined {
  const explicit = Date.parse(account.quotaExhaustedAt ?? '');
  if (Number.isFinite(explicit)) return explicit;
  const last = Date.parse(account.usageLearning?.hits?.at(-1)?.at ?? '');
  return Number.isFinite(last) ? last : undefined;
}

/** When a failover mark stops holding on its own, in epoch ms. Every path
 * that marks an account dates it (quotaExhaustedAt, or the refusal the usage
 * learner recorded), so a mark with no date at all is not one ClikCode wrote
 * in a turn; with nothing to measure a window from, it holds as before. */
export function quotaMarkExpiresAt(account: AiHarnessAccount): number | undefined {
  if (account.quotaState !== 'exhausted') return undefined;
  const retry = Date.parse(account.quotaRetryAt ?? '');
  if (Number.isFinite(retry)) return retry;
  const marked = quotaMarkedAt(account);
  return marked === undefined ? Number.POSITIVE_INFINITY : marked + QUOTA_MARK_DEFAULT_MS;
}

/** Is this account out of quota right now?
 *
 * The one answer every screen and every failover decision uses. Decided on
 * the unrounded `usedPct >= 100`, never on the display string ("0% left" is
 * also what 99.6% used rounds to).
 *
 * A reading's spent window holds until its own `resetsAt`. A failover mark
 * (`quotaState: 'exhausted'`) holds until the first of:
 *  - a window that was spent when the vendor refused has since reset;
 *  - a reading taken after the refusal shows room;
 *  - the mark's own expiry (the vendor's hint, else QUOTA_MARK_DEFAULT_MS).
 * Without these the mark only cleared on a successful turn, and failover
 * never attempts a turn on an account it believes is spent -- so an account
 * whose quota had been back for ten hours still read "out of usage". */
export function accountQuotaSpent(account: AiHarnessAccount, now: number = Date.now()): boolean {
  const reading = account.usage as AccountUsageReading | undefined;
  const windows = reading?.windows ?? [];
  const spent = windows.filter((window) => window.usedPct >= 100);
  if (spent.some((window) => window.resetsAt === undefined || Date.parse(window.resetsAt) > now)) return true;
  if (account.quotaState !== 'exhausted') return false;
  const marked = quotaMarkedAt(account);
  // Only a window still spent at the moment of the refusal explains it. One
  // that had already reset before then says nothing about why it refused.
  if (spent.some((window) => marked === undefined || Date.parse(window.resetsAt!) > marked)) return false;
  const readAt = Date.parse(reading?.at ?? '');
  if (windows.length && !reading?.failed && marked !== undefined && Number.isFinite(readAt) && readAt > marked) return false;
  return (quotaMarkExpiresAt(account) ?? 0) > now;
}

/** Can this account take a turn now? Signed in, not held by the vendor for
 * verification, and not out of quota by the rule above. Every "has usage"
 * decision -- failover, Resume in, the preferred account, the pickers, the
 * status labels -- asks this, so none of them can disagree about an account. */
export function accountCanTakeTurn(account: AiHarnessAccount, now: number = Date.now()): boolean {
  return account.status === 'ready' && !account.verification && !accountQuotaSpent(account, now);
}

/** Record a quota refusal. `retryAt` is the vendor's own reset hint, when the
 * refusal carried one. */
export function markQuotaExhausted(account: AiHarnessAccount, now: number = Date.now(), retryAt?: string): void {
  account.quotaState = 'exhausted';
  account.quotaExhaustedAt = new Date(now).toISOString();
  account.quotaRetryAt = retryAt;
}

export function clearQuotaMark(account: AiHarnessAccount): void {
  if (account.quotaState === 'exhausted') account.quotaState = 'available';
  account.quotaExhaustedAt = undefined;
  account.quotaRetryAt = undefined;
}

/** Clear a mark the rule no longer upholds, so the stored record says what
 * every screen already derives. Returns whether anything changed. */
export function settleQuotaMark(account: AiHarnessAccount, now: number = Date.now()): boolean {
  if (account.quotaState !== 'exhausted' || accountQuotaSpent(account, now)) return false;
  clearQuotaMark(account);
  return true;
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

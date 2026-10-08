/** What a usage reading is -- a window, a remaining fraction, a reset time --
 * and how one is labelled, cached and judged current. No probing here. */

import { quotaResetPhrase } from '../protocol/format.js';
import type { AiHarnessAccount } from '../definition.js';

/** One quota window as the vendor reported it. `usedPct` is the unrounded
 * percentage used (0..100+); the display label rounds, this does not, so
 * "99.6% used" is never mistaken for exhausted. */
export interface UsageWindow {
  name: string; usedPct: number; resetsAt?: string;
  /** A share of the plan that, used up, still leaves the account working:
   *  Cursor's API window covers named models only, and Auto keeps running
   *  until the plan total is spent. Shown, never what marks it spent. */
  advisory?: true;
}

/** Whether this window, used up, stops the account. */
export function windowSpent(window: UsageWindow): boolean {
  return window.usedPct >= 100 && !window.advisory;
}

/** A usage reading: the structured windows plus the label the UI shows. */
export interface UsageReading {
  windows: UsageWindow[]; label?: string;
  /** The account's plan as the vendor named it, when the same answer says. */
  plan?: NonNullable<AiHarnessAccount['plan']>;
  /** What the vendor said about the account itself instead of a figure:
   * its sign-in was rejected (Kimi: "re-login required"), or it must be
   * held by the vendor (Antigravity: VALIDATION_REQUIRED with the link to
   * verify, RESTRICTED_AGE with none). Was read as "no figure", and the
   * account stayed ready. */
  account?: 'signed-out' | { verify?: string };
}

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

/** An account's usage in one line, wherever it is shown (/usage, the
 * editor's account menu): its windows' figures, else the label of a reading
 * with none (a balance); a learned estimate says it is one. */
export function accountUsageText(usage: { label?: string; windows: readonly UsageWindow[]; learned?: boolean }): string | undefined {
  const text = usage.learned ? usage.label ?? usageReadingLabel(usage.windows) : usageReadingLabel(usage.windows) ?? usage.label;
  return text && usage.learned ? `${text} · estimated` : text;
}

/** "resets at 8:00PM", derived from the same vendor-reported `resetsAt` the
 * usage windows already carry -- not computed independently. Only speaks for
 * a window that is actually exhausted right now (matches accountQuotaSpent's
 * `usedPct >= 100` threshold) and whose reset is still ahead of us; picks the
 * soonest one when more than one window is spent. */
export function usageResetLabel(windows: readonly UsageWindow[] | undefined, now: number = Date.now()): string | undefined {
  const exhausted = (windows ?? [])
    .filter((window): window is UsageWindow & { resetsAt: string } => windowSpent(window) && window.resetsAt !== undefined && Date.parse(window.resetsAt) > now)
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

/** The windows the vendor reported for this account, from a reading that
 * did not fail. */
export function vendorWindows(account: AiHarnessAccount): UsageWindow[] {
  const reading = account.usage as AccountUsageReading | undefined;
  const windows = reading && !reading.failed ? reading.windows ?? [] : [];
  const disproven = account.disprovenWindows;
  return disproven?.length ? windows.filter((window) => !disproven.includes(windowKey(window))) : windows;
}

/** One window of one period: a new period has a new reset. */
export function windowKey(window: Pick<UsageWindow, 'name' | 'resetsAt'>): string {
  return `${window.name}@${window.resetsAt ?? ''}`;
}

/** When a refusal mark stops holding on its own, in epoch ms: the vendor's
 * own "resets in" hint, else QUOTA_MARK_DEFAULT_MS after the refusal. A mark
 * with no date (older builds) is not upheld: nothing says how long it holds,
 * and a turn that is refused again marks it again. */
export function quotaMarkExpiresAt(account: AiHarnessAccount): number | undefined {
  if (account.quotaState !== 'exhausted') return undefined;
  const retry = Date.parse(account.quotaRetryAt ?? '');
  if (Number.isFinite(retry)) return retry;
  const marked = Date.parse(account.quotaExhaustedAt ?? '');
  return Number.isFinite(marked) ? marked + QUOTA_MARK_DEFAULT_MS : undefined;
}

/** Is this account out of quota right now?
 *
 * The one answer every screen and every failover decision uses, from two
 * facts only, both the vendor's:
 *  - a window it reported spent (`usedPct >= 100`, unrounded) holds until
 *    that window's own reset, or until a newer reading when it gave none;
 *  - a refusal holds until its expiry (above), unless a reading the vendor
 *    published after it shows no window spent. Only a window that can stop
 *    the account speaks to a refusal: an advisory one (Antigravity's pools,
 *    Cline's credits) does not say the account has room. */
export function accountQuotaSpent(account: AiHarnessAccount, now: number = Date.now()): boolean {
  return vendorWindows(account).some((window) => windowSpent(window) && (window.resetsAt === undefined || Date.parse(window.resetsAt) > now))
    || quotaRefusalHolds(account, now);
}

/** The refusal half of accountQuotaSpent: the vendor refused this account
 * and nothing since says otherwise. What moves a chat off its own account
 * before a turn -- a reading alone does not (account-routing.ts). */
export function quotaRefusalHolds(account: AiHarnessAccount, now: number = Date.now()): boolean {
  const expires = quotaMarkExpiresAt(account);
  if (expires === undefined || expires <= now) return false;
  const readAt = Date.parse(account.usage?.at ?? '');
  const markedAt = Date.parse(account.quotaExhaustedAt ?? '');
  return !(vendorWindows(account).some((window) => !window.advisory) && readAt > markedAt);
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

/** How long any answer about an account's usage -- a figure, a balance, or
 * a probe that failed -- stands before its harness is asked again. Every
 * probe is free (none runs a model), so this is set by how soon a change made
 * elsewhere -- a reset, a turn on another device -- should show, not by cost.
 * Shared through `usageCheckedAt`, so any number of open chats and windows
 * ask once per account per interval. */
export const USAGE_RECHECK_MS = 60_000;

/** When this account's usage was last asked for, by any process. */
export function usageAskedAt(account: AiHarnessAccount): number {
  return Math.max(Number.NEGATIVE_INFINITY, ...[account.usage?.at, account.usageCheckedAt]
    .map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
}

/** Vendors describe a quota window by its length, not by a name. 300 minutes
 * and 10080 minutes are the two everyone actually uses, and naming them the
 * way the endpoint probe already does keeps one wording for one account no
 * matter which path produced the reading. */
export function usageWindowName(minutes: number): string {
  // A month as Codex reports it (43,200 minutes, 30 days); vendors may count
  // 28 to 31. It read "720h".
  if (minutes >= 40_320 && minutes <= 44_640) return 'monthly';
  if (minutes === 10_080) return 'weekly';
  if (minutes === 1_440) return 'daily';
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Claude Code's `rate_limit_info` -- on its stream-json `rate_limit_event`,
 * and forwarded by claude-agent-acp as `usage_update._meta["_claude/rateLimit"]`:
 * `unifiedWindows.{five_hour,seven_day}` with a 0..1 `utilization`. */
export function claudeRateLimitReading(info: unknown): UsageReading | undefined {
  const windows = (info as { unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown; resets_at?: unknown } | undefined> } | undefined)?.unifiedWindows;
  if (!windows) return undefined;
  const window = (name: string, value?: { utilization?: unknown; resetsAt?: unknown; resets_at?: unknown }): UsageWindow | undefined =>
    usageWindow(name, typeof value?.utilization === 'number' ? value.utilization * 100 : undefined, value?.resetsAt ?? value?.resets_at);
  return usageReading([window('5h', windows.five_hour), window('weekly', windows.seven_day)]);
}

/** The offset of `timeZone` from UTC at `at`, in ms. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(at);
  const part = (type: string): number => Number(parts.find((item) => item.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - at;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A vendor's reset in its named zone -- "Oct 1, 1:50pm" or just "11am" in
 * "America/Denver" -- as an instant. Claude words both its `/usage` lines and
 * its refusals this way. With no date it is the next time that zone's clock
 * reads it; with no year, the nearest such date. */
export function zonedResetTime(text: string, timeZone: string, now: number = Date.now()): string | undefined {
  const match = /^(?:([a-z]{3})[a-z]*\.? (\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text.trim());
  const month = match?.[1] ? MONTHS.indexOf(match[1].toLowerCase()) : undefined;
  if (!match || month === -1) return undefined;
  const hour = (Number(match[3]) % 12) + (match[5]!.toLowerCase() === 'pm' ? 12 : 0);
  const minute = Number(match[4] ?? 0);
  try {
    const instant = (year: number, monthIndex: number, day: number): number => {
      const wall = Date.UTC(year, monthIndex, day, hour, minute);
      const first = wall - zoneOffsetMs(wall, timeZone);
      return wall - zoneOffsetMs(first, timeZone);
    };
    const today = new Date(now + zoneOffsetMs(now, timeZone));
    const year = today.getUTCFullYear();
    let at: number;
    if (month === undefined) {
      at = instant(year, today.getUTCMonth(), today.getUTCDate());
      if (at <= now) at = instant(year, today.getUTCMonth(), today.getUTCDate() + 1);
    } else {
      at = instant(year, month, Number(match[2]));
      if (at < now - 86_400_000) at = instant(year + 1, month, Number(match[2]));
    }
    return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
  } catch { return undefined; } // fail-open-ok: an unknown zone leaves the window without a reset, not wrong
}

/** Claude Code's own `/usage`, a local command that calls no model:
 *   Current session: 3% used · resets Oct 1, 1:50pm (America/Denver)
 *   Current week (all models): 82% used · resets Oct 3, 1pm (America/Denver)
 * The session line is the 5-hour window. */
export function claudeUsageCommandReading(text: string, now: number = Date.now()): UsageReading | undefined {
  const line = (label: string, name: string): UsageWindow | undefined => {
    const found = new RegExp(`${label}:\\s*(\\d+(?:\\.\\d+)?)% used(?:\\s*·\\s*resets ([^(\\n]+?)\\s*\\(([^)\\n]+)\\))?`, 'i').exec(text);
    if (!found) return undefined;
    return usageWindow(name, Number(found[1]), found[2] && found[3] ? zonedResetTime(found[2], found[3], now) : undefined);
  };
  return usageReading([line('Current session', '5h'), line('Current week \\(all models\\)', 'weekly')]);
}

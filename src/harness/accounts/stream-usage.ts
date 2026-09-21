/** Usage learned from a turn that is already running, rather than from a
 * probe: the quota lines vendors emit mid-stream. */

import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import type { HarnessSession } from '../types.js';
import { claudeStreamReading, claudeStreamUsage, codexRateLimitsReading, recentReadingByLabel } from './usage-probes.js';
import { AccountUsageReading, UsageCacheEntry, UsageReading, UsageWindow, nativeUsageCache, usageCacheKey, usageReading, usageWindow } from './usage-reading.js';

/** Quota a harness reports on its own stream, recognised by the SHAPE of the
 * record rather than by which harness sent it.
 *
 * A harness that is being driven is the authority on its own quota: it knows
 * what it just spent, and it says so for free on the stream already being
 * parsed. Keying that by harness name meant every new vendor started out
 * unable to report something it was already reporting, and pushed the ones
 * without an entry onto an HTTP endpoint instead -- a per-account budget that
 * several open terminals exhaust between them.
 *
 * Two shapes cover every vendor seen so far, and an unknown record simply
 * matches neither:
 *   - `rate_limit_event.rate_limit_info.unifiedWindows` (Claude Code), whose
 *     utilization is a 0..1 fraction;
 *   - a `rate_limits` object with `primary`/`secondary` windows (Codex, and
 *     anything else carrying the app-server's shape), in 0..100 percent. */
export function streamQuotaReading(value: unknown): UsageReading | undefined {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  if (!record) return undefined;
  const info = record.rate_limit_info ?? record.rateLimitInfo;
  const unified = info && typeof info === 'object'
    ? (info as { unifiedWindows?: unknown; unified_windows?: unknown }).unifiedWindows
      ?? (info as { unified_windows?: unknown }).unified_windows
    : undefined;
  if (unified && typeof unified === 'object') {
    const windows = unified as Record<string, { utilization?: unknown; resetsAt?: unknown; resets_at?: unknown } | undefined>;
    const window = (name: string, key: string): UsageWindow | undefined => {
      const entry = windows[key];
      return usageWindow(
        name, typeof entry?.utilization === 'number' ? entry.utilization * 100 : undefined,
        entry?.resetsAt ?? entry?.resets_at,
      );
    };
    return usageReading([window('5h', 'five_hour'), window('weekly', 'seven_day')]);
  }
  return codexRateLimitsReading(record.rate_limits ?? record.rateLimits);
}

/** Read a stream line for quota, whatever harness produced it. */
export function streamQuotaReadingFromLine(lineText: string): UsageReading | undefined {
  // Self-gated: ordinary output lines are not re-parsed as JSON.
  if (!lineText.includes('rate_limit') && !lineText.includes('rateLimit')) return undefined;
  try {
    return streamQuotaReading(JSON.parse(lineText));
  } catch {
    // fail-open-ok: one unparseable line on a decoration path. The turn's own
    // output is read elsewhere and is unaffected.
    return undefined;
  }
}

/** Harnesses whose quota arrives on their turn stream. Every harness is read
 * by shape, so this says "this one reports for itself", nothing more: it is
 * what tells the caller not to ask an endpoint for what the harness gives. */
export const NATIVE_STREAM_USAGE: Readonly<Partial<Record<string, (lineText: string) => string | undefined>>> = {
  claude: claudeStreamUsage,
};

/** Structured counterpart of NATIVE_STREAM_USAGE. */
export const NATIVE_STREAM_USAGE_READINGS: Readonly<Partial<Record<string, (lineText: string) => UsageReading | undefined>>> = {
  claude: claudeStreamReading,
};

export function accountUsageFrom(entry: UsageCacheEntry): AccountUsageReading {
  return {
    at: new Date(entry.at).toISOString(),
    ...(entry.label === undefined ? {} : { label: entry.label }),
    ...(entry.failed ? { failed: true } : {}),
    ...(entry.windows?.length ? { windows: entry.windows } : {}),
  };
}

/** Publish a reading onto the account so every terminal sees it, and into the
 * in-process cache so this terminal's next paint does not re-probe. */
async function publishUsageReading(cacheKey: string, accountId: string | null | undefined, reading: UsageReading): Promise<void> {
  const entry: UsageCacheEntry = { at: Date.now(), ...(reading.label === undefined ? {} : { label: reading.label }), ...(reading.windows.length ? { windows: reading.windows } : {}) };
  nativeUsageCache.set(cacheKey, entry);
  if (!accountId) return;
  const state = await readState();
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;
  account.usage = accountUsageFrom(entry);
  // writeState merges usage by newest `at`, so this cannot disturb another
  // terminal or be reverted by one holding an older snapshot.
  await writeState(state).catch(() => undefined);
}

/** Read usage off a turn's own output line, if this harness reports it there.
 * A reading taken this way costs nothing and refreshes on every turn, so the
 * endpoint probe is left to cover only the cold start: a terminal that has not
 * run a turn yet has no stream to read. */
export async function recordNativeStreamUsage(session: HarnessSession, lineText: string): Promise<string | undefined> {
  if (!session.nativeHarness) return undefined;
  // By shape first, so a harness reporting quota in a known form is read
  // whether or not anyone has registered it by name.
  const structured = streamQuotaReadingFromLine(lineText)
    ?? NATIVE_STREAM_USAGE_READINGS[session.nativeHarness]?.(lineText);
  return recordDerivedUsage(session, structured ?? NATIVE_STREAM_USAGE[session.nativeHarness]?.(lineText));
}

/** Publish a reading the harness gave us for free during a turn, from whichever
 * transport it arrived on -- a stdout line, or an app-server notification.
 * Accepts a structured reading (preferred) or just its label. */
export async function recordDerivedUsage(session: HarnessSession, usage: string | UsageReading | undefined): Promise<string | undefined> {
  if (!usage) return undefined;
  const reading: UsageReading = typeof usage === 'string' ? recentReadingByLabel.get(usage) ?? { windows: [], label: usage } : usage;
  if (!reading.label) return undefined;
  const cacheKey = usageCacheKey(session.nativeHarness, session.accountId, session.nativeSessionId);
  await publishUsageReading(cacheKey, session.accountId, reading).catch(() => undefined);
  return reading.label;
}

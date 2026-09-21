/** The account-facing answer: given an account, what is its usage and what
 * should it say on screen. */

import { writeState } from '../../session/state/write.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import type { AiHarnessAccount } from '../definition.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { NATIVE_USAGE_FAILURE_TTL_MS, NATIVE_USAGE_PROBES, NATIVE_USAGE_READING_PROBES } from './usage-probes.js';
import { AccountUsageReading, UsageCacheEntry, UsageReading, nativeUsageCache, usageCacheKey, usageReadingIsCurrent } from './usage-reading.js';
import { NATIVE_STREAM_USAGE_READINGS, accountUsageFrom } from './stream-usage.js';

/** The structured reading behind nativeUsageLabel: same caching, same sharing. */
export async function nativeUsageReading(
  session: HarnessSession, state: HarnessState, options: { network?: boolean } = {},
): Promise<UsageReading | undefined> {
  const probe = session.nativeHarness ? NATIVE_USAGE_PROBES[session.nativeHarness] : undefined;
  // A harness that reports on its own turn stream has a usage source even with
  // no probe behind it, and its readings are already in the cache below. This
  // gate used to be `if (!probe) return undefined`, which meant removing a
  // probe also made every reading that harness had already given unreadable.
  const reportsOnStream = session.nativeHarness ? NATIVE_STREAM_USAGE_READINGS[session.nativeHarness] !== undefined : false;
  if (!probe && !reportsOnStream) return undefined;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const cacheKey = usageCacheKey(session.nativeHarness, account?.id, session.nativeSessionId);
  const cached = nativeUsageCache.get(cacheKey);
  // The account's own record is the shared reading: every terminal sees it, so
  // the cost of displaying usage no longer multiplies by the number of open
  // chats. The in-process map stays in front of it as a fast path for repeated
  // paints within one terminal.
  const shared = account?.usage as AccountUsageReading | undefined;
  const sharedEntry: UsageCacheEntry | undefined = shared && {
    at: Date.parse(shared.at), ...(shared.label === undefined ? {} : { label: shared.label }),
    ...(shared.failed ? { failed: true } : {}), ...(shared.windows?.length ? { windows: shared.windows } : {}),
  };
  // Whichever is newer: another terminal may have published since this
  // process last cached.
  const entry = cached && sharedEntry ? (sharedEntry.at > cached.at ? sharedEntry : cached) : cached ?? sharedEntry;
  // Usage is not cached. These numbers move while nobody is looking -- a turn
  // runs on the same account somewhere else, a window rolls over -- so there
  // is no time-based memo here deciding that a figure is still good enough.
  //
  // What IS reused is the harness's own last report, and only for exactly as
  // long as that report says it is true: a reading carries the resetsAt of
  // every window it describes, and is dropped the moment the soonest one
  // passes. That is the value's own stated validity, not an interval this
  // code invented. A reading with no window cannot make that claim, so it is
  // never reused at all -- which is what let "usage rate limited", a label
  // with nothing in it to expire, sit in the status line for the life of the
  // process.
  //
  // An explicit ask (`/usage`, the account picker) always goes to the
  // harness, because the point of asking is to find out now.
  // A failed probe is held off briefly -- see NATIVE_USAGE_FAILURE_TTL_MS.
  // That is not a cached figure; there is no figure.
  if (entry?.failed && Number.isFinite(entry.at) && Date.now() - entry.at < NATIVE_USAGE_FAILURE_TTL_MS && !options.network) {
    return entry.label === undefined ? undefined : { windows: entry.windows ?? [], label: entry.label };
  }
  const reusable = entry && !entry.failed && (entry.windows?.length ?? 0) > 0 && usageReadingIsCurrent(entry)
    ? entry
    : undefined;
  if (reusable && !options.network) {
    nativeUsageCache.set(cacheKey, reusable);
    return { windows: reusable.windows ?? [], ...(reusable.label === undefined ? {} : { label: reusable.label }) };
  }
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const structured = session.nativeHarness ? NATIVE_USAGE_READING_PROBES[session.nativeHarness] : undefined;
  const reading: UsageReading | undefined = !probe
    ? undefined
    : structured && structured.label === probe
      ? await structured.reading(session, environment).catch(() => undefined)
      : await probe(session, environment).then((label) => (label === undefined ? undefined : { windows: [], label })).catch(() => undefined);
  // Carry the last known figure through a failure rather than blanking it --
  // but never past its own reset, when it stops describing anything.
  const carried = entry && usageReadingIsCurrent(entry) ? entry : undefined;
  const next: UsageCacheEntry = reading?.label === undefined
    ? { at: Date.now(), failed: true, ...(carried?.label === undefined ? {} : { label: carried.label }), ...(carried?.windows?.length ? { windows: carried.windows } : {}) }
    : { at: Date.now(), label: reading.label, ...(reading.windows.length ? { windows: reading.windows } : {}) };
  nativeUsageCache.set(cacheKey, next);
  if (account) {
    account.usage = accountUsageFrom(next);
    // writeState merges per field, so publishing this reading cannot disturb
    // anything another terminal changed meanwhile.
    await writeState(state).catch(() => undefined);
  }
  return { windows: next.windows ?? [], ...(next.label === undefined ? {} : { label: next.label }) };
}

export async function nativeUsageLabel(
  session: HarnessSession, state: HarnessState, options: { network?: boolean } = {},
): Promise<string | undefined> {
  return (await nativeUsageReading(session, state, options))?.label;
}

function accountPseudoSession(account: AiHarnessAccount, state: HarnessState, harnessCommand: string): HarnessSession {
  const related = state.sessions.find((item) => item.accountId === account.id && item.nativeSessionId);
  return related ?? {
    id: `account:${account.id}`, route: 'local', accountId: account.id, provider: account.provider,
    model: null, effort: 'medium', accountFailover: 'never', createdAt: '', updatedAt: '', status: 'active',
    nativeHarness: harnessCommand,
  };
}

/** Usage is probed per-session above (it needs a native session id for OpenCode);
 * an account has no session of its own, so borrow one of its sessions if it has
 * any, or a bare stand-in otherwise — codexUsageProbe ignores the session
 * argument entirely, and a stand-in with no nativeSessionId simply yields no
 * OpenCode label rather than a wrong one. */
/** Whether anything can ever produce a usage figure for this harness: a probe
 * we can run, or a turn stream it reports on itself. The account picker and
 * the status line both ask this before showing a usage column at all. */
export function harnessReportsUsage(command: string): boolean {
  return NATIVE_USAGE_PROBES[command] !== undefined || NATIVE_STREAM_USAGE_READINGS[command] !== undefined;
}

export async function accountUsageLabel(
  account: AiHarnessAccount, state: HarnessState, options: { network?: boolean } = {},
): Promise<string | undefined> {
  return (await accountUsageReading(account, state, options))?.label;
}

export async function accountUsageReading(
  account: AiHarnessAccount, state: HarnessState, options: { network?: boolean } = {},
): Promise<UsageReading | undefined> {
  if (account.authKind !== 'vendor-cli') return undefined;
  const harness = localHarnessForProvider(account.provider);
  if (!harness || !harnessReportsUsage(harness.command)) return undefined;
  return nativeUsageReading(accountPseudoSession(account, state, harness.command), state, options);
}

/** What the harness last reported for this account, if it is still true.
 *
 * The picker renders from this immediately and asks the harness in the
 * background, so opening it never waits. Same rule as the read above: a
 * reading stands until the soonest window it describes resets, and a reading
 * with no window is not shown at all rather than shown forever. */
export function cachedAccountUsageLabel(account: AiHarnessAccount, state: HarnessState): string | undefined {
  if (account.authKind !== 'vendor-cli') return undefined;
  const harness = localHarnessForProvider(account.provider);
  if (!harness || !harnessReportsUsage(harness.command)) return undefined;
  void state;
  const reported = nativeUsageCache.get(usageCacheKey(harness.command, account.id));
  if (!reported || reported.failed || !(reported.windows?.length ?? 0)) return undefined;
  return usageReadingIsCurrent(reported) ? reported.label : undefined;
}

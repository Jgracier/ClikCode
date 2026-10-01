/** The account-facing answer: given an account, what is its usage and what
 * should it say on screen. */

import { writeState } from '../../session/state/write.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import type { AiHarnessAccount } from '../definition.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { BILLED_USAGE_PROBES, NATIVE_USAGE_FAILURE_TTL_MS, NATIVE_USAGE_PROBES, NATIVE_USAGE_READING_PROBES } from './usage-probes.js';
import { learnedUsageReading } from './usage-learning.js';
import { AccountUsageReading, UsageCacheEntry, UsageReading, nativeUsageCache, quotaMarkExpiresAt, quotaMarkedAt, settleQuotaMark, usageCacheKey, usageReadingIsCurrent } from './usage-reading.js';
import { NATIVE_STREAM_USAGE_READINGS, accountUsageFrom } from './stream-usage.js';

/** How long a windowless balance reading is reused before its harness is
 * asked again (a turn on the account asks sooner). */
export const BALANCE_READING_TTL_MS = 5 * 60_000;

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
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  // Harnesses without a native quota probe or stream reading can learn a
  // figure from this account's own history -- see
  // usage-learning.ts. It needs no probe, no network and no cache (it is
  // arithmetic over invocations we already store), so it short-circuits ahead
  // of all of that. It returns undefined until the account has actually hit
  // the limit enough times to know where it is, which is why this reads as
  // "no usage source" exactly as before on a fresh account.
  if (!probe && !reportsOnStream) {
    if (!account) return undefined;
    return learnedUsageReading(account.usageLearning, state.invocations, account.id, Date.now());
  }
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
  // A harness that reports only through its probe cannot refresh the figure
  // itself, so a turn STARTED on the account since the reading makes it old
  // news. Started, not ended: a reading a turn published about itself (Codex's
  // rate-limit notification) is taken after its start and stays current.
  const turnSinceReading = entry !== undefined && !reportsOnStream && account !== undefined
    && state.invocations.some((invocation) => invocation.accountId === account.id
      && Date.parse(invocation.at) - invocation.latencyMs > entry.at);
  // A credit balance (Auggie, Amp, Kilo) has no window to say how long it
  // holds, and its source is a server no file shows -- so a short TTL, and
  // only that. Without it the status line's 15s tick re-ran the vendor's
  // balance command in every open terminal.
  const heldBalance = entry !== undefined && !(entry.windows?.length) && entry.label !== undefined
    && Number.isFinite(entry.at) && Date.now() - entry.at < BALANCE_READING_TTL_MS;
  const reusable = entry && !entry.failed && ((entry.windows?.length ?? 0) > 0 ? usageReadingIsCurrent(entry) : heldBalance) && !turnSinceReading
    ? entry
    : undefined;
  if (reusable && !options.network) {
    nativeUsageCache.set(cacheKey, reusable);
    return { windows: reusable.windows ?? [], ...(reusable.label === undefined ? {} : { label: reusable.label }) };
  }
  // A probe that is a real turn (Claude Code's) runs only on an explicit ask.
  // A passive paint -- opening a chat, the status line's timer, the editor's
  // footer -- used to run one whenever no current reading existed: on every
  // start with a fresh home, and again each minute while it failed. Free
  // probes (Codex, Auggie, Grok) still run here, held off by the failure
  // backoff above and by a current reading.
  if (!options.network && BILLED_USAGE_PROBES.has(session.nativeHarness ?? '')) return undefined;
  // A probe spawns the vendor CLI, and a CLI run while signed out can start a
  // login or onboarding (Kiro's session list did). Only an account that is
  // signed in is asked; anything else keeps what it last had.
  if (!account || account.status !== 'ready') {
    return entry?.label === undefined ? undefined : { windows: entry.windows ?? [], label: entry.label };
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
    // The moment a reading shows room, the refusal it overtakes is cleared on
    // the record too -- not left for the next failover to notice.
    if (reading?.label !== undefined) settleQuotaMark(account);
    // writeState merges per field, so publishing this reading cannot disturb
    // anything another terminal changed meanwhile.
    await writeState(state).catch(() => undefined);
  }
  return { windows: next.windows ?? [], ...(next.label === undefined ? {} : { label: next.label }) };
}

async function nativeUsageLabel(
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
// There was a harnessReportsUsage(command) gate here, asking whether any
// harness could ever produce a usage figure. Every harness can now: one has a
// probe, or reports on its own stream, or has a limit learned from its own
// refusals. A predicate that is true for all twenty-four inputs is not a
// gate, so it is gone rather than left returning a constant.
//
// The question that actually matters was always the other one -- does this
// account have something to say RIGHT NOW -- and that is answered where the
// evidence lives: a probe returns nothing, or learnedUsageReading withholds a
// figure until the account has hit its limit enough times to place it.

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
  if (!harness) return undefined;
  return nativeUsageReading(accountPseudoSession(account, state, harness.command), state, options);
}

/** What the harness last reported for this account, if it is still true.
 * The picker reads the in-process cache and the account record shared by
 * other ClikCode processes. Windows expire at their reset; balances have a
 * short TTL because the vendor gives no reset time. */
export function cachedAccountUsageLabel(account: AiHarnessAccount, state: HarnessState): string | undefined {
  if (account.authKind !== 'vendor-cli') return undefined;
  const harness = localHarnessForProvider(account.provider);
  if (!harness) return undefined;
  void state;
  const reported = nativeUsageCache.get(usageCacheKey(harness.command, account.id));
  const shared = account.usage as AccountUsageReading | undefined;
  const sharedAt = Date.parse(shared?.at ?? '');
  const latest = shared && Number.isFinite(sharedAt) && (!reported || sharedAt > reported.at)
    ? { at: sharedAt, label: shared.label, failed: shared.failed, windows: shared.windows }
    : reported;
  if (!latest || latest.failed || latest.label === undefined) return undefined;
  if (latest.windows?.length) return usageReadingIsCurrent(latest) ? latest.label : undefined;
  return Date.now() - latest.at < BALANCE_READING_TTL_MS ? latest.label : undefined;
}

/** Accounts that were out of quota and may not be any more, on a harness
 * that can be asked.
 *
 * Only the chat's own account was ever re-read, so an account that ran out
 * kept its last reading -- "5h 0% left" -- until someone opened the picker,
 * and nothing said its quota had come back. Due when that reading has gone
 * past a reset it describes, or when the refusal it is marked with has
 * expired and no reading since has said otherwise. */
function accountUsageCanBeAsked(account: AiHarnessAccount): boolean {
  let command: string | undefined;
  try { command = localHarnessForProvider(account.provider)?.command; } catch { command = undefined; }
  return Boolean(command && NATIVE_USAGE_PROBES[command]);
}

export function accountsDueForUsageRecheck(
  state: HarnessState, now: number = Date.now(), canBeAsked: (account: AiHarnessAccount) => boolean = accountUsageCanBeAsked,
): AiHarnessAccount[] {
  return state.accounts.filter((account) => {
    if (account.authKind !== 'vendor-cli' || account.status !== 'ready' || !canBeAsked(account)) return false;
    const reading = account.usage as AccountUsageReading | undefined;
    const windows = reading?.windows ?? [];
    const wasSpent = account.quotaState === 'exhausted' || windows.some((window) => window.usedPct >= 100);
    if (!wasSpent) return false;
    if (windows.length && !usageReadingIsCurrent({ windows }, now)) return true;
    if (account.quotaState !== 'exhausted' || (quotaMarkExpiresAt(account) ?? Number.POSITIVE_INFINITY) > now) return false;
    // A current reading taken after the refusal already answers it.
    const readAt = Date.parse(reading?.at ?? '');
    const marked = quotaMarkedAt(account);
    return !(windows.length && !reading?.failed && Number.isFinite(readAt) && marked !== undefined && readAt > marked);
  });
}

/** When each account was last re-checked by this process: a probe that keeps
 * failing is asked at most this often, whatever the poll rate. Fifteen
 * minutes, not one: for some vendors (Claude) reading usage IS a model turn,
 * and a re-check that keeps failing once a minute would spend the very quota
 * it is waiting for. A reset that has passed is still noticed within a
 * quarter hour, and a turn on the account clears the mark at once anyway. */
const recheckedAt = new Map<string, number>();
const RECHECK_MIN_INTERVAL_MS = 15 * 60_000;

/** Re-read every account that is due (see above). Each probe publishes its
 * reading to the shared record and clears a refusal it overtakes, so every
 * terminal's /accounts, status line and failover see the quota the moment it
 * is back. */
export async function recheckRecoveredAccounts(state: HarnessState, now: number = Date.now()): Promise<void> {
  const due = accountsDueForUsageRecheck(state, now)
    .filter((account) => now - (recheckedAt.get(account.id) ?? 0) >= RECHECK_MIN_INTERVAL_MS);
  for (const account of due) {
    recheckedAt.set(account.id, now);
    await accountUsageReading(account, state, { network: true }).catch(() => undefined);
  }
}

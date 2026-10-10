/** The account-facing answer: given an account, what is its usage and what
 * should it say on screen. */

import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { nativeProfileEnvironment } from '../transport/profile-environment.js';
import { localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import type { AiHarnessAccount } from '../definition.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { NATIVE_USAGE_PROBES } from './usage-probes.js';
import { AccountUsageReading, USAGE_RECHECK_MS, UsageCacheEntry, UsageReading, nativeUsageCache, settleQuotaMark, usageAskedAt, usageCacheKey, usageReadingIsCurrent, vendorWindows, windowSpent } from './usage-reading.js';
import { NATIVE_STREAM_USAGE_READINGS, accountUsageFrom } from './stream-usage.js';
import { learnedReading, learnsUsage, preferLearnedReading } from './learned-usage.js';

/** Probes in flight, by usage cache key. Opening a conversation asks for its
 * usage from more than one place at once (the status line and the account
 * refresh), and each spawned the vendor CLI: Grok's probe ran twice
 * concurrently at every start. A second ask while one runs gets its answer. */
const probesInFlight = new Map<string, Promise<UsageReading | undefined>>();

function probeOnce(key: string, probe: () => Promise<UsageReading | undefined>): Promise<UsageReading | undefined> {
  const running = probesInFlight.get(key);
  if (running) return running;
  const asked = probe().catch(() => undefined).finally(() => probesInFlight.delete(key));
  probesInFlight.set(key, asked);
  return asked;
}

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
  // Nothing to ask and nothing on the stream: what its refusals have taught,
  // if anything yet.
  if (!probe && !reportsOnStream) return account ? learnedReading(state, account) : undefined;
  const shownReading = (reading: UsageReading | undefined): UsageReading | undefined =>
    account ? preferLearnedReading(state, account, reading) : reading;
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
  // What the harness last said is reused only while it is both still true
  // and recent: never past a reset it named, never past a turn that started
  // on the account since (in any terminal), and never longer than
  // USAGE_RECHECK_MS after anyone last asked. One clock for figures,
  // balances and failed probes alike, kept on the account record, so a
  // change made anywhere -- a reset, another device's turn -- shows within
  // a minute and the asking does not multiply by open chats. An explicit
  // ask (`/usage`, the account picker) always goes to the harness.
  //
  // A reading a turn published about itself (Codex's rate-limit
  // notification, Claude Code's rate_limit_event) is taken after that turn
  // started, so the turn does not make it old.
  const turnSinceReading = entry !== undefined && account !== undefined
    && state.invocations.some((invocation) => invocation.accountId === account.id
      && Date.parse(invocation.at) - invocation.latencyMs > entry.at);
  const askedAt = Math.max(entry?.at ?? Number.NEGATIVE_INFINITY, account ? usageAskedAt(account) : Number.NEGATIVE_INFINITY);
  const reusable = entry && Date.now() - askedAt < USAGE_RECHECK_MS && !turnSinceReading
    && (entry.failed || usageReadingIsCurrent(entry)) ? entry : undefined;
  if (reusable && !options.network) {
    nativeUsageCache.set(cacheKey, reusable);
    return shownReading(reusable.label === undefined ? undefined : { windows: reusable.windows ?? [], label: reusable.label });
  }
  // A probe spawns the vendor CLI, and a CLI run while signed out can start a
  // login or onboarding (Kiro's session list did). Only an account that is
  // signed in is asked; anything else keeps what it last had.
  if (!account || account.status !== 'ready') {
    return shownReading(entry?.label === undefined ? undefined : { windows: entry.windows ?? [], label: entry.label });
  }
  account.usageCheckedAt = new Date().toISOString();
  const environment = nativeProfileEnvironment(account?.nativeProfile);
  const reading: UsageReading | undefined = probe ? await probeOnce(cacheKey, () => probe(environment)) : undefined;
  // Carry the last known figure through a failure rather than blanking it --
  // but never past its own reset, when it stops describing anything. The
  // failed probe itself is not stored as usage.
  const carried = entry && usageReadingIsCurrent(entry) ? entry : undefined;
  const probedAt = Date.now();
  const next: UsageCacheEntry = reading?.label !== undefined
    ? { at: probedAt, label: reading.label, ...(reading.windows.length ? { windows: reading.windows } : {}) }
    : { at: probedAt, failed: true, ...(carried?.label === undefined ? {} : { label: carried.label }), ...(carried?.windows?.length ? { windows: carried.windows } : {}) };
  nativeUsageCache.set(cacheKey, next);
  // The plan rides on the same answer; it says which models are free
  // (free-plan.ts), and stays as last said when a reading leaves it out.
  if (reading?.plan) account.plan = reading.plan;
  // The vendor's word on the account itself is what the account is now.
  if (reading?.account === 'signed-out') account.status = 'needs_login';
  else if (reading?.account) account.verification = { ...(reading.account.verify ? { url: reading.account.verify } : {}), at: new Date(probedAt).toISOString() };
  if (reading?.label !== undefined) {
    account.usage = accountUsageFrom(next);
    // The moment a reading shows room, the refusal it overtakes is cleared on
    // the record too -- not left for the next failover to notice.
    settleQuotaMark(account);
  } else if (carried?.windows?.length && account.usage?.failed) {
    account.usage = {
      at: new Date(carried.at).toISOString(),
      ...(carried.label === undefined ? {} : { label: carried.label }),
      windows: carried.windows,
    } as AiHarnessAccount['usage'];
  } else if (!carried?.windows?.length) {
    account.usage = accountUsageFrom(next);
  }
  // writeState merges per field, so publishing this reading cannot disturb
  // anything another terminal changed meanwhile.
  await writeState(state).catch(() => undefined);
  const shown = !reading?.label && carried?.windows?.length ? carried : next;
  return shownReading({
    windows: shown.windows ?? [],
    ...(shown.label === undefined ? {} : { label: shown.label }),
    ...(reading?.plan ? { plan: reading.plan } : {}),
  });
}

function accountPseudoSession(account: AiHarnessAccount, state: HarnessState, harnessCommand: string): HarnessSession {
  const related = state.sessions.find((item) => item.accountId === account.id && item.nativeSessionId);
  return related ?? {
    id: `account:${account.id}`, route: 'local', accountId: account.id, provider: account.provider,
    model: null, effort: 'medium', createdAt: '', updatedAt: '', status: 'active',
    nativeHarness: harnessCommand,
  };
}

/** Usage is probed per-session above (it needs a native session id for OpenCode);
 * an account has no session of its own, so borrow one of its sessions if it has
 * any, or a bare stand-in otherwise — codexUsageProbe ignores the session
 * argument entirely, and a stand-in with no nativeSessionId simply yields no
 * OpenCode label rather than a wrong one. */
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
 * other ClikCode processes. Windows expire at their reset; a balance names
 * no reset, so it stands only as long as any reading does (USAGE_RECHECK_MS). */
export function cachedAccountUsageLabel(account: AiHarnessAccount, state: HarnessState): string | undefined {
  if (learnsUsage(account)) return learnedReading(state, account)?.label;
  if (account.authKind !== 'vendor-cli') return undefined;
  const harness = localHarnessForProvider(account.provider);
  if (!harness) return undefined;
  const reported = nativeUsageCache.get(usageCacheKey(harness.command, account.id));
  const shared = account.usage as AccountUsageReading | undefined;
  const sharedAt = Date.parse(shared?.at ?? '');
  const latest = shared && Number.isFinite(sharedAt) && (!reported || sharedAt > reported.at)
    ? { at: sharedAt, label: shared.label, failed: shared.failed, windows: shared.windows }
    : reported;
  if (!latest || latest.failed || latest.label === undefined) return undefined;
  if (latest.windows?.length) return usageReadingIsCurrent(latest) ? latest.label : undefined;
  return Date.now() - latest.at < USAGE_RECHECK_MS ? latest.label : undefined;
}

function accountUsageCanBeAsked(account: AiHarnessAccount): boolean {
  let command: string | undefined;
  try { command = localHarnessForProvider(account.provider)?.command; } catch { command = undefined; }
  return Boolean(command && NATIVE_USAGE_PROBES[command]);
}

/** How long a signed-in account that is not held is left before it is read
 * again. Every account, not only held ones: Amp and Kilo showed a failure two
 * days old because nothing asked again, and a sign-in the vendor rejected
 * went unnoticed. Longer than USAGE_RECHECK_MS because there are many -- a
 * hundred accounts on a one-minute clock is a vendor process a second. */
export const USAGE_IDLE_RECHECK_MS = 15 * 60_000;

/** Signed-in accounts on a harness that can be asked, due to be read again:
 * one held out of turns (a refusal on record, dated or not, or a spent
 * window) once nobody has asked for USAGE_RECHECK_MS -- a stated reset is not
 * waited for, vendors round them ("resets 11am" came back at 10:50) -- and
 * any other once nobody has for USAGE_IDLE_RECHECK_MS. */
export function accountsDueForUsageRecheck(
  state: HarnessState, now: number = Date.now(), canBeAsked: (account: AiHarnessAccount) => boolean = accountUsageCanBeAsked,
): AiHarnessAccount[] {
  return state.accounts.filter((account) => {
    if (account.authKind !== 'vendor-cli' || account.status !== 'ready' || !canBeAsked(account)) return false;
    const held = account.quotaState === 'exhausted' || vendorWindows(account).some(windowSpent);
    return now - usageAskedAt(account) >= (held ? USAGE_RECHECK_MS : USAGE_IDLE_RECHECK_MS);
  });
}

/** Re-read every account that is due (see above). Each probe stamps the
 * shared clock, publishes its reading and clears a refusal it overtakes, so
 * every terminal's /accounts, status line and failover see the quota the
 * moment it is back.
 *
 * One pass at a time per process, and each account is judged again on the
 * index as it is just before its probe: a pass over thirty held accounts
 * outlasts the 15 s tick that starts it, and every open window ran one. Each
 * re-asked what another pass (its own earlier one, another window's) had just
 * read -- a vendor process and a full index write per account, several times
 * a second while nothing was happening. */
export function recheckRecoveredAccounts(state: HarnessState, options: {
  now?: number;
  /** Tests: the probe, and which accounts can be probed. */
  ask?: (account: AiHarnessAccount, latest: HarnessState) => Promise<unknown>;
  canBeAsked?: (account: AiHarnessAccount) => boolean;
} = {}): Promise<void> {
  const ask = options.ask ?? ((account, latest) => accountUsageReading(account, latest, { network: true }));
  const canBeAsked = options.canBeAsked ?? accountUsageCanBeAsked;
  rechecking ??= (async () => {
    for (const due of accountsDueForUsageRecheck(state, options.now, canBeAsked)) {
      const latest = await readState({ transcripts: [] });
      const account = latest.accounts.find((item) => item.id === due.id);
      if (!account || !accountsDueForUsageRecheck({ ...latest, accounts: [account] }, Date.now(), canBeAsked).length) continue;
      await ask(account, latest).catch(() => undefined);
    }
  })().finally(() => { rechecking = undefined; });
  return rechecking;
}
let rechecking: Promise<void> | undefined;

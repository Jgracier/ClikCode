/** Where learned usage applies, and what keeps it current: a harness that
 * reports no usage of its own (no probe, nothing on its turn stream, no
 * vendor window on the account). Wherever the vendor reports usage, that is
 * the answer, and this is never consulted. See usage-learning.ts.
 *
 * A free plan whose probe names the plan and nothing else ("Free plan", no
 * window) has not reported a figure. Grok Build's billing probe is that
 * case: the weekly percent is the paid meter, and a free account's allowance
 * shows up here once a refusal has named it. */
import { localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import type { AiHarnessAccount } from '../definition.js';
import type { HarnessState } from '../../session/model.js';
import { planIsFree } from './free-plan.js';
import { NATIVE_USAGE_PROBES } from './usage-probes.js';
import { NATIVE_STREAM_USAGE_READINGS } from './stream-usage.js';
import { usageWindowTitle, vendorWindows, type UsageReading } from './usage-reading.js';
import { CANDIDATE_WINDOWS, learnedResetAt, learnedUsageReading, recordAllowedTurn, recordRefusal, seedLedger, turnCost, type UsageLearning } from './usage-learning.js';

type Invocation = HarnessState['invocations'][number];

/** "Free plan" names the tier. It is not a remaining-usage figure, and it
 * must not keep a free account out of learning. A real label ("Weekly 63%
 * left", "$3 left") still is the vendor's answer, free plan or not. */
function planLabelOnly(account: AiHarnessAccount): boolean {
  if (account.usage?.label && account.usage.label !== 'Free plan') return false;
  return account.usage?.label === 'Free plan' || planIsFree(account.plan);
}

export function learnsUsage(account: AiHarnessAccount): boolean {
  if (account.authKind !== 'vendor-cli') return false;
  // Whatever the vendor reported -- windows, or a balance with none -- is the
  // answer for this account. A free-plan label with no window is not one.
  if (vendorWindows(account).length) return false;
  if (account.usage?.label && !account.usage.failed && !planLabelOnly(account)) return false;
  let command: string | undefined;
  try { command = localHarnessForProvider(account.provider)?.command; } catch { return false; } // fail-open-ok: no catalog, no harness to learn for
  if (!command || NATIVE_STREAM_USAGE_READINGS[command]) return false;
  // A probe answers paid plans. A free account whose probe published no
  // window still has nothing to show until a refusal teaches it.
  if (NATIVE_USAGE_PROBES[command] && !planLabelOnly(account)) return false;
  return true;
}

/** When a turn started: the log records when it ended and how long it took. */
function turnStart(invocation: Invocation): number {
  return Date.parse(invocation.at) - (invocation.latencyMs ?? 0);
}

/** The account's learning, with a ledger. An account that has none yet gets
 * one from the invocation log -- which keeps every record of the last
 * RAW_RETENTION_DAYS (session/state/invocations.ts), more than a weekly
 * window, so the ledger is complete from the oldest it holds, and a refusal
 * from before that keeps its own snapshot. Refusals already on record learn
 * when a turn was next allowed after them. */
export function learningFor(state: HarnessState, account: AiHarnessAccount, now: number = Date.now()): UsageLearning {
  const stored = account.usageLearning;
  if (stored && (stored.turns.length || stored.since !== undefined)) return stored;
  const starts = (state.invocations ?? []).map(turnStart).filter(Number.isFinite);
  const own = (state.invocations ?? []).filter((invocation) => invocation.accountId === account.id && Number.isFinite(turnStart(invocation)));
  const seeded = seedLedger(own.map((invocation) => ({ start: turnStart(invocation), cost: turnCost(invocation) })), now);
  const since = Math.max(seeded.since ?? 0, starts.length ? Math.min(...starts) : now);
  const hits = (stored?.hits ?? []).map((hit) => {
    if (hit.cleared) return hit;
    const next = seeded.turns.find(([start]) => start > Date.parse(hit.at));
    return next ? { ...hit, cleared: new Date(next[0]).toISOString() } : hit;
  });
  return { turns: seeded.turns, since, hits };
}

/** A turn the vendor allowed, already in the invocation log. */
export function noteAllowedTurn(state: HarnessState, account: AiHarnessAccount, invocation: Invocation, now: number = Date.now()): void {
  if (!learnsUsage(account)) return;
  const learning = learningFor(state, account, now);
  // A ledger seeded just now came from the log, which already holds this turn.
  account.usageLearning = learning === account.usageLearning
    ? recordAllowedTurn(learning, turnStart(invocation), turnCost(invocation), now)
    : learning;
}

/** A turn the vendor refused for quota. Returns when it is learned to end,
 * for a refusal that did not say. */
export function noteRefusal(state: HarnessState, account: AiHarnessAccount, now: number, retryAt?: string, windowMs?: number): string | undefined {
  if (!learnsUsage(account)) return undefined;
  account.usageLearning = recordRefusal(learningFor(state, account, now), now, retryAt, windowMs);
  return learnedResetAt(account.usageLearning, now);
}

/** The vendor named the window's length and the account is still out, but
 * the ledger cannot measure the limit yet. Show that window spent, resetting
 * when the refusal said the mark ends — the same shape as a learned window. */
function namedWindowReading(account: AiHarnessAccount, now: number): UsageReading | undefined {
  if (account.quotaState !== 'exhausted') return undefined;
  const retry = Date.parse(account.quotaRetryAt ?? '');
  if (!Number.isFinite(retry) || retry <= now) return undefined;
  const hit = [...(account.usageLearning?.hits ?? [])].reverse().find((item) => !item.cleared && item.windowMs);
  const window = CANDIDATE_WINDOWS.find((candidate) => candidate.ms === hit?.windowMs);
  if (!window) return undefined;
  return {
    windows: [{ name: window.name, usedPct: 100, resetsAt: new Date(retry).toISOString() }],
    label: `${usageWindowTitle(window.name)} ~0% left`,
  };
}

/** The learned reading, for an account whose harness reports none. */
export function learnedReading(state: HarnessState, account: AiHarnessAccount, now: number = Date.now()): UsageReading | undefined {
  if (!learnsUsage(account)) return undefined;
  return learnedUsageReading(learningFor(state, account, now), now) ?? namedWindowReading(account, now);
}

/** A probe that published no window leaves the learned reading in front.
 * Paid readings (any window, or a balance that is not a plan name) pass
 * through unchanged. */
export function preferLearnedReading(
  state: HarnessState, account: AiHarnessAccount, probed: UsageReading | undefined, now: number = Date.now(),
): UsageReading | undefined {
  if (!learnsUsage(account)) return probed;
  const learned = learnedReading(state, account, now);
  if (!learned?.windows.length) return probed;
  return { ...learned, ...(probed?.plan ? { plan: probed.plan } : {}) };
}

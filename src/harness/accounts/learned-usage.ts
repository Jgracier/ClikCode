/** Where learned usage applies, and what keeps it current: a harness that
 * reports no usage of its own (no probe, nothing on its turn stream, no
 * vendor window on the account). Wherever the vendor reports usage, that is
 * the answer, and this is never consulted. See usage-learning.ts. */
import { localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import type { AiHarnessAccount } from '../definition.js';
import type { HarnessState } from '../../session/model.js';
import { NATIVE_USAGE_PROBES } from './usage-probes.js';
import { NATIVE_STREAM_USAGE_READINGS } from './stream-usage.js';
import { vendorWindows, type UsageReading } from './usage-reading.js';
import { learnedResetAt, learnedUsageReading, recordAllowedTurn, recordRefusal, seedLedger, turnCost, type UsageLearning } from './usage-learning.js';

type Invocation = HarnessState['invocations'][number];

export function learnsUsage(account: AiHarnessAccount): boolean {
  if (account.authKind !== 'vendor-cli') return false;
  // Whatever the vendor reported -- windows, or a balance with none -- is the
  // answer for this account.
  if (vendorWindows(account).length || (account.usage?.label && !account.usage.failed)) return false;
  let command: string | undefined;
  try { command = localHarnessForProvider(account.provider)?.command; } catch { return false; } // fail-open-ok: no catalog, no harness to learn for
  return Boolean(command && !NATIVE_USAGE_PROBES[command] && !NATIVE_STREAM_USAGE_READINGS[command]);
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
export function noteRefusal(state: HarnessState, account: AiHarnessAccount, now: number, retryAt?: string): string | undefined {
  if (!learnsUsage(account)) return undefined;
  account.usageLearning = recordRefusal(learningFor(state, account, now), now, retryAt);
  return learnedResetAt(account.usageLearning, now);
}

/** The learned reading, for an account whose harness reports none. */
export function learnedReading(state: HarnessState, account: AiHarnessAccount, now: number = Date.now()): UsageReading | undefined {
  return learnsUsage(account) ? learnedUsageReading(learningFor(state, account, now), now) : undefined;
}

/** Compacting a conversation whose live context has grown large, before the next step re-reads it.
 *
 * Every step of an agent loop reads the whole context again, so what a turn costs scales with the
 * context it runs on (session/compact-setting.ts has the measurements and the default). After a
 * COMPLETED turn that leaves the context at or over the user's threshold, the harness's own
 * compaction runs as a turn of its own, from the same place compact-before-switch.ts runs.
 *
 * Uses the size the harness itself reported (`lastUsage.contextUsed`, or its percent of the window)
 * and the model's window. Never repeats: after it runs, the context has to shrink (it worked) or
 * grow by a margin (it did not) before it may run again. */
import type { HarnessSession, HarnessState } from '../session/model.js';
import { compactThreshold } from '../session/compact-setting.js';
import { canCompact } from '../tui/slash/compact.js';

/** A compaction that left the context where it was is not tried again until it has grown by this much. */
export const COMPACT_REGROWTH_TOKENS = 50_000;

/** Context size each conversation had when it was last compacted by size. */
const compactedFrom = new Map<string, number>();

/** What the harness says the conversation's context holds, in tokens. */
export function contextTokens(session: Pick<HarnessSession, 'lastUsage'>): number | undefined {
  const usage = session.lastUsage;
  if (usage?.contextUsed !== undefined && usage.contextUsed > 0) return usage.contextUsed;
  if (usage?.contextPercent !== undefined && usage.contextWindow) return Math.round(usage.contextPercent / 100 * usage.contextWindow);
  return undefined;
}

/** Whether a conversation that has just finished a turn should be compacted for its size.
 * The caller has checked that nothing else is running or pending (it knows the worker). */
export function shouldCompactByContext(state: Pick<HarnessState, 'globalSettings'>, session: HarnessSession): boolean {
  const threshold = compactThreshold(state.globalSettings, session.lastUsage?.contextWindow);
  if (threshold === undefined) return false;
  const used = contextTokens(session);
  if (used === undefined) return false;
  const before = compactedFrom.get(session.id);
  // Under the threshold again: it worked, and the threshold alone decides from here.
  if (used < threshold) { compactedFrom.delete(session.id); return false; }
  // Still over: not again until it has grown past where it was when it last ran.
  if (before !== undefined && used < before + COMPACT_REGROWTH_TOKENS) return false;
  if (session.queuedTurns?.some((entry) => entry.kind !== 'notification')) return false;
  return canCompact(session.id, session);
}

export function noteCompactedByContext(session: HarnessSession): void {
  const used = contextTokens(session);
  if (used !== undefined) compactedFrom.set(session.id, used);
}

/** For tests. */
export function forgetCompactedByContext(sessionId?: string): void {
  if (sessionId) compactedFrom.delete(sessionId); else compactedFrom.clear();
}

/** What the worker is doing that a size compaction must wait for: a turn (never mid-turn), another
 * compaction on its way, notifications still to deliver, the vendor's own background turn or
 * out-of-turn words, and work the vendor left running. */
export interface WorkerActivity {
  turnRunning: boolean; compactionStarting: boolean; notifications: number;
  backgroundTurn: boolean; outOfTurn: boolean; vendorWorkRunning: boolean;
}
export function workerIsBusy(activity: WorkerActivity): boolean {
  return activity.turnRunning || activity.compactionStarting || activity.notifications > 0
    || activity.backgroundTurn || activity.outOfTurn || activity.vendorWorkRunning;
}

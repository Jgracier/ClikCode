/** What each harness call cost. Individual invocations are capped; the
 * rollups and totals derived from them are not. */

import type { HarnessState } from '../model.js';
import { StateIndex } from './index-file.js';
import { hidden } from './merge.js';

/** Individual invocation records kept; older ones fold into per-day totals. */
const INVOCATION_KEEP = 1000;

export type Invocation = HarnessState['invocations'][number];

export interface InvocationRollup {
  day: string; accountId: string; provider: string; model?: string;
  calls: number; inputTokens: number; outputTokens: number; latencyMs: number;
}

function rollupKey(invocation: Invocation): string {
  // An absent model groups with other absent ones rather than being folded
  // into some real model's totals.
  return [String(invocation.at).slice(0, 10), invocation.accountId, invocation.provider, invocation.model ?? ''].join('|');
}

/** Keeps the newest INVOCATION_KEEP records and folds the rest into per-day,
 * per-account, per-model totals, so usage totals stay exact while the file
 * stops growing with every request ever made. */
export function capInvocations(index: StateIndex): void {
  if (index.invocations.length <= INVOCATION_KEEP) return;
  const ordered = index.invocations
    .map((invocation, position) => ({ invocation, position }))
    .sort((left, right) => String(left.invocation.at).localeCompare(String(right.invocation.at)) || left.position - right.position);
  const overflow = ordered.slice(0, ordered.length - INVOCATION_KEEP);
  const rolled = new Set(overflow.map((entry) => entry.invocation));
  const rollups = { ...index.invocationRollups };
  for (const { invocation } of overflow) {
    const key = rollupKey(invocation);
    const previous = rollups[key] ?? {
      day: String(invocation.at).slice(0, 10), accountId: invocation.accountId, provider: invocation.provider, model: invocation.model,
      calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0,
    };
    rollups[key] = {
      ...previous,
      calls: previous.calls + 1,
      inputTokens: previous.inputTokens + (invocation.inputTokens ?? 0),
      outputTokens: previous.outputTokens + (invocation.outputTokens ?? 0),
      latencyMs: previous.latencyMs + (invocation.latencyMs ?? 0),
    };
    if (!index.rolledThrough || String(invocation.at) > index.rolledThrough) index.rolledThrough = String(invocation.at);
  }
  index.invocationRollups = rollups;
  index.invocations = index.invocations.filter((invocation) => !rolled.has(invocation));
}

export const STATE_ROLLUPS = Symbol('clikcode.invocationRollups');

/** Per-day totals of invocations older than the newest INVOCATION_KEEP. */
export function invocationRollups(state: HarnessState): InvocationRollup[] {
  return Object.values((state as HarnessState & { [STATE_ROLLUPS]?: Record<string, InvocationRollup> })[STATE_ROLLUPS] ?? {});
}

interface InvocationTotals { calls: number; inputTokens: number; outputTokens: number; latencyMs: number }

/** All-time totals: the retained records plus everything rolled up. `match`
 * narrows by account/provider/model (the dimensions a rollup preserves). */
function invocationTotals(
  state: HarnessState,
  match: (entry: { accountId: string; provider: string; model?: string }) => boolean = () => true,
): InvocationTotals {
  const totals: InvocationTotals = { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  for (const invocation of state.invocations ?? []) {
    if (!match(invocation)) continue;
    totals.calls += 1;
    totals.inputTokens += invocation.inputTokens ?? 0;
    totals.outputTokens += invocation.outputTokens ?? 0;
    totals.latencyMs += invocation.latencyMs ?? 0;
  }
  for (const rollup of invocationRollups(state)) {
    if (!match(rollup)) continue;
    totals.calls += rollup.calls;
    totals.inputTokens += rollup.inputTokens;
    totals.outputTokens += rollup.outputTokens;
    totals.latencyMs += rollup.latencyMs;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export function totalsOf(invocations: readonly Invocation[], rollups: Record<string, InvocationRollup>): InvocationTotals {
  const state = hidden({ invocations } as unknown as HarnessState, STATE_ROLLUPS, rollups);
  return invocationTotals(state);
}

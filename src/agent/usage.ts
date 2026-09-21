/** Per-turn usage ledger. Pure: the loop owns when to report. */
import type { TokenUsage } from './model-client.js';

interface UsageLedgerEntry {
  step: number;
  usage: TokenUsage;
  servedModel?: string;
}

interface UsageLedger {
  entries: UsageLedgerEntry[];
  total: TokenUsage;
  /** Input size of the most recent step: the best available measure of how
   * full the context window currently is. */
  lastInputTokens?: number;
}

const FIELDS = ['input', 'output', 'cached', 'cacheWrite', 'reasoning', 'costMicroUsd'] as const;

/** Sum two usages. A field stays absent when neither side reported it, so
 * "the vendor said nothing" never degrades into a fabricated 0. */
function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const out: TokenUsage = {};
  for (const field of FIELDS) {
    const a = left[field];
    const b = right[field];
    if (typeof a === 'number' || typeof b === 'number') out[field] = (finite(a) ?? 0) + (finite(b) ?? 0);
  }
  return out;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function emptyLedger(): UsageLedger {
  return { entries: [], total: {} };
}

export function recordUsage(ledger: UsageLedger, entry: UsageLedgerEntry): UsageLedger {
  const input = finite(entry.usage.input);
  return {
    entries: [...ledger.entries, entry],
    total: addUsage(ledger.total, entry.usage),
    lastInputTokens: input ?? ledger.lastInputTokens,
  };
}

function aggregateUsage(usages: readonly TokenUsage[]): TokenUsage {
  return usages.reduce<TokenUsage>((total, usage) => addUsage(total, usage), {});
}

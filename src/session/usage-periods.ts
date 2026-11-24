/** Tokens per account by hour, day, week, month and year, beside what the same turns would have
 * used under the vendor's default compaction (turn/context-shadow.ts): `clikcode usage --by`, and
 * the totals in `/usage all`. From the turn log and its per-day rollups; hours older than the raw
 * log (30 days) are not kept, so the hourly view covers the log only. Periods are local time;
 * a folded day is the UTC day it was folded under. */
import type { HarnessState } from './model.js';
import { invocationRollups, invocationTokenCount } from './state/invocations.js';
import { tokensWithoutTune } from '../turn/context-shadow.js';

export const USAGE_PERIODS = ['hour', 'day', 'week', 'month', 'year'] as const;
export type UsagePeriod = typeof USAGE_PERIODS[number];

export interface UsagePeriodRow {
  /** `2026-11-24 14:00`, `2026-11-24`, `2026-W48` (from its Monday), `2026-11`, `2026`. */
  period: string;
  accountId: string;
  provider: string;
  turns: number;
  tokens: number;
  costUsd: number;
  /** Turns whose cost was reported. */
  costTurns: number;
  /** Turns carrying context readings, and their tokens: the part the comparison is measured on. */
  measuredTurns: number;
  measuredTokens: number;
  /** The measured turns' tokens under the vendor's default compaction. */
  withoutTuneTokens: number;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The period `at` falls in, in local time. */
export function periodKey(at: Date, period: UsagePeriod): string {
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  switch (period) {
    case 'hour': return `${day} ${pad(at.getHours())}:00`;
    case 'day': return day;
    case 'week': {
      const monday = new Date(at.getFullYear(), at.getMonth(), at.getDate() - ((at.getDay() + 6) % 7));
      return `week of ${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
    }
    case 'month': return day.slice(0, 7);
    case 'year': return String(at.getFullYear());
  }
}

/** Every account's use per `period`, newest period first; within a period, most tokens first.
 * `since` (ms) keeps only what was recorded from then on. */
export function usageByPeriod(
  state: Pick<HarnessState, 'invocations'>, period: UsagePeriod, options: { since?: number; accountId?: string } = {},
): UsagePeriodRow[] {
  const rows = new Map<string, UsagePeriodRow>();
  const row = (key: string, accountId: string, provider: string): UsagePeriodRow => {
    const id = `${key}\0${accountId}`;
    let found = rows.get(id);
    if (!found) {
      found = { period: key, accountId, provider, turns: 0, tokens: 0, costUsd: 0, costTurns: 0, measuredTurns: 0, measuredTokens: 0, withoutTuneTokens: 0 };
      rows.set(id, found);
    }
    return found;
  };
  const wanted = (accountId: string): boolean => !options.accountId || options.accountId === accountId;
  for (const invocation of state.invocations) {
    const at = Date.parse(invocation.at);
    if (!wanted(invocation.accountId) || (options.since !== undefined && at < options.since)) continue;
    const target = row(periodKey(new Date(at), period), invocation.accountId, invocation.provider);
    const tokens = invocationTokenCount(invocation);
    target.turns += 1;
    target.tokens += tokens;
    if (invocation.costUsd !== undefined) { target.costUsd += invocation.costUsd; target.costTurns += 1; }
    if (invocation.contextCalls) {
      target.measuredTurns += 1;
      target.measuredTokens += tokens;
      target.withoutTuneTokens += tokensWithoutTune(tokens, invocation);
    }
  }
  // Folded days have no hours.
  if (period !== 'hour') {
    for (const rollup of invocationRollups(state as HarnessState)) {
      const at = new Date(`${rollup.day}T12:00:00`);
      if (!wanted(rollup.accountId) || (options.since !== undefined && at.getTime() < options.since)) continue;
      const target = row(periodKey(at, period), rollup.accountId, rollup.provider);
      target.turns += rollup.calls;
      target.tokens += rollup.totalTokens ?? rollup.inputTokens + rollup.outputTokens;
      target.measuredTurns += rollup.shadowCalls ?? 0;
      target.measuredTokens += rollup.shadowTokens ?? 0;
      target.withoutTuneTokens += rollup.withoutTuneTokens ?? 0;
    }
  }
  return [...rows.values()].sort((left, right) => right.period.localeCompare(left.period) || right.tokens - left.tokens);
}

/** What the comparison says over some rows: tokens saved on the measured turns, and its share. */
export function tuneSaving(rows: readonly Pick<UsagePeriodRow, 'measuredTokens' | 'withoutTuneTokens' | 'tokens'>[]): { measuredTokens: number; withoutTuneTokens: number; savedTokens: number; savedShare: number; coverage: number } {
  const measuredTokens = rows.reduce((sum, row) => sum + row.measuredTokens, 0);
  const withoutTuneTokens = rows.reduce((sum, row) => sum + row.withoutTuneTokens, 0);
  const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const savedTokens = withoutTuneTokens - measuredTokens;
  return { measuredTokens, withoutTuneTokens, savedTokens, savedShare: withoutTuneTokens ? savedTokens / withoutTuneTokens : 0, coverage: tokens ? measuredTokens / tokens : 0 };
}

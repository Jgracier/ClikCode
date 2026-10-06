/** Grok Build's plan allowance, asked of Grok Build.
 *
 * The CLI has no usage subcommand for the allowance (`grok usage <session>`
 * prints a session's own tokens and cost, which the turn stream already
 * carries). Its TUI `/usage` modal gets the allowance from the agent's ACP
 * extension method `_x.ai/billing`, and `grok agent stdio` answers that same
 * method to any client -- no session, no prompt, so no model turn is spent.
 *
 * Verified against grok 1.0.34 on a SuperGrok account, with the TUI's
 * "Weekly limit (SuperGrok) 0%  Resets: October 5, 17:16" beside it:
 *
 *   {"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY",
 *     "start":"2026-09-28T23:16:51.066254+00:00","end":"2026-10-05T23:16:51.066254+00:00"},
 *    "onDemandCap":{"val":0},"onDemandUsed":{"val":0},"prepaidBalance":{"val":0},
 *    "isUnifiedBillingUser":true,"billingPeriodStart":"…","billingPeriodEnd":"…"},
 *   "subscription_tier":"SuperGrok"}
 *
 * `creditUsagePercent` is the used share. It is a protobuf scalar, so the
 * JSON omits it at zero -- which is why a fresh week above has none, and why
 * the TUI reads that same payload as 0%. A payload with no current period is
 * not a plan window (a team account's limits "are managed by your team") and
 * yields no reading rather than an invented one. */

import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import type { HarnessSession } from '../../session/model.js';
import { queryAcp } from './acp-query.js';
import { type UsageReading, usageReading, usageWindow } from './usage-reading.js';

type Json = Record<string, any>;

const PERIOD_NAMES: Readonly<Record<string, string>> = {
  USAGE_PERIOD_TYPE_DAILY: 'daily',
  USAGE_PERIOD_TYPE_WEEKLY: 'weekly',
  USAGE_PERIOD_TYPE_MONTHLY: 'monthly',
};

/** A proto number, bare or in the `{val}` wrapper Grok uses for amounts. */
function protoNumber(value: unknown): number | undefined {
  const raw = value && typeof value === 'object' ? (value as { val?: unknown }).val : value;
  const parsed = typeof raw === 'string' ? Number(raw) : raw;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

/** The allowance window in an `_x.ai/billing` result, or undefined when it
 * describes none. */
export function grokBillingReading(result: unknown): UsageReading | undefined {
  const config = (result as Json | undefined)?.config as Json | undefined;
  const period = config?.currentPeriod as Json | undefined;
  if (!period || typeof period !== 'object') return undefined;
  const type = typeof period.type === 'string' ? period.type : '';
  const name = PERIOD_NAMES[type] ?? (type.replace(/^USAGE_PERIOD_TYPE_/, '').toLowerCase() || 'plan');
  const reading = usageReading([usageWindow(name, protoNumber(config!.creditUsagePercent) ?? 0, period.end ?? config!.billingPeriodEnd)]);
  const tier = (result as Json).subscription_tier;
  return reading && typeof tier === 'string' && tier ? { ...reading, plan: { name: tier } } : reading;
}

/** One short-lived `grok agent stdio`, asked `_x.ai/billing` and let go.
 * `--no-leader` keeps the probe off a shared leader another window owns. */
export async function grokUsageReading(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<UsageReading | undefined> {
  let binary = 'grok';
  try { binary = localHarnessForCommand('grok')?.binary ?? binary; } catch { /* fail-open-ok: the catalog default is the documented binary */ }
  const result = await queryAcp(binary, ['agent', '--no-leader', 'stdio'], environment,
    (request) => request('_x.ai/billing', { format: 'credits' }));
  return grokBillingReading(result);
}

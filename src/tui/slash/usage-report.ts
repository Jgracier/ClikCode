/** `/usage`: quota, tokens, and cost for the provider you are in; `/usage
 * all` for every provider and the last seven days. */

import { isClikCodeAgent } from '../../session/route.js';
import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { compactCount, dollars } from '../../harness/protocol/format.js';
import { invocationRollups } from '../../session/state/invocations.js';
import { accountQuotaSpent, accountUsageText, usageResetLabel } from '../../harness/accounts/usage-reading.js';
import { accountUsage } from '../../session/picker-rows.js';

type Invocation = HarnessState['invocations'][number];

export interface UsageReportTotals {
  accounts: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  costKnown: boolean;
}

function tokenCount(invocation: Invocation): number {
  if (invocation.totalTokens !== undefined) return invocation.totalTokens;
  return (invocation.inputTokens ?? 0) + (invocation.outputTokens ?? 0);
}

function sumInvocations(invocations: readonly Invocation[]): UsageReportTotals {
  return invocations.reduce<UsageReportTotals>((total, invocation) => ({
    accounts: total.accounts,
    turns: total.turns + 1,
    inputTokens: total.inputTokens + (invocation.inputTokens ?? 0),
    outputTokens: total.outputTokens + (invocation.outputTokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (invocation.cacheReadTokens ?? 0),
    totalTokens: total.totalTokens + tokenCount(invocation),
    costUsd: total.costUsd + (invocation.costUsd ?? 0),
    costKnown: total.costKnown || invocation.costUsd !== undefined,
  }), { accounts: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUsd: 0, costKnown: false });
}

function allowance(account: AiHarnessAccount, state: HarnessState, now: number): { label: string; reset?: string } {
  const usage = accountUsage(account, state, now);
  const label = usage && accountUsageText(usage);
  if (usage && label) {
    const reset = usageResetLabel(usage.windows, now);
    return { label, ...(reset ? { reset } : {}) };
  }
  if (account.status === 'needs_login') return { label: 'needs reauthentication' };
  if (accountQuotaSpent(account, now)) return { label: 'out of usage' };
  return { label: 'not reported yet' };
}

function accountLines(account: AiHarnessAccount, state: HarnessState, session: HarnessSession, now: number): string[] {
  const totals = sumInvocations(state.invocations.filter((item) => item.accountId === account.id));
  const quota = allowance(account, state, now);
  const name = account.id === session.accountId ? `${account.label} · current` : account.label;
  const figures = [compactCount(totals.totalTokens)];
  if (totals.costKnown) figures.push(dollars(totals.costUsd));
  return [
    `  ${name}`,
    ...(quota.label === 'not reported yet' ? [] : [`  ${quota.label}`]),
    ...(quota.reset ? [`  ${quota.reset}`] : []),
    `  ${figures.join(' · ')}`,
  ];
}

function splitLines(totals: UsageReportTotals): string[] {
  const flow = [`${compactCount(totals.inputTokens)} in`, `${compactCount(totals.outputTokens)} out`];
  const lines = [`  ${flow.join(' · ')}`];
  if (totals.cacheReadTokens > 0) lines.push(`  ${compactCount(totals.cacheReadTokens)} cached`);
  return lines;
}

/** Ids that name this chat's provider. A session stores the catalog id
 * (`xai`) and sometimes only the command (`grok`). Accounts are filed under
 * the catalog id. Both have to match, for every harness, not one of them. */
function providerIds(session: HarnessSession, providerId?: string): Set<string> {
  return new Set([providerId, session.provider, session.nativeHarness].filter((id): id is string => Boolean(id)));
}

/** Quota and metered use for every account on the harness this chat is using,
 * then those figures added together, then this conversation. Nothing here
 * asks a vendor: a percentage is the last saved window or the learned limit,
 * and tokens are the turns ClikCode itself recorded. */
export function usageReport(
  state: HarnessState, session: HarnessSession, options: { now?: number; providerName?: string; providerId?: string } = {},
): { text: string; totals: UsageReportTotals } {
  const now = options.now ?? Date.now();
  const ids = providerIds(session, options.providerId);
  const providerName = options.providerName ?? session.provider ?? session.nativeHarness ?? 'this provider';
  // ClikCode's own agent signs in to no vendor account.
  const accounts = isClikCodeAgent(session) ? [] : state.accounts.filter((account) => ids.has(account.provider));
  const accountIds = new Set(accounts.map((account) => account.id));
  const providerInvocations = state.invocations.filter((item) => accountIds.has(item.accountId) || ids.has(item.provider));
  const totals = { ...sumInvocations(providerInvocations), accounts: accounts.length };
  const conversation = sumInvocations(state.invocations.filter((item) => item.sessionId === session.id));
  const chatBits = [`${conversation.turns} ${conversation.turns === 1 ? 'turn' : 'turns'}`, compactCount(conversation.totalTokens)];
  if (conversation.costKnown) chatBits.push(dollars(conversation.costUsd));
  const lines = [
    providerName,
    '',
    ...(accounts.length ? accounts.flatMap((account, index) => [...(index ? [''] : []), ...accountLines(account, state, session, now)]) : ['  No accounts on this provider']),
    '',
    ...(accounts.length === 1 ? [] : [`  ${totals.accounts} accounts · ${totals.turns} ${totals.turns === 1 ? 'turn' : 'turns'}`]),
    ...splitLines(totals),
    ...(totals.costKnown && accounts.length !== 1 ? [`  ${dollars(totals.costUsd)}`] : []),
    '',
    `  This chat · ${chatBits.join(' · ')}`,
  ];
  return { text: lines.join('\n'), totals };
}

const DAY_MS = 24 * 60 * 60_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM-DD` in local time: a day is the user's day, not UTC's. */
function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** A cost that is only partly known is an `at least` (`$1.20+`); one never
 * recorded is left out -- never `$0.00`, which would claim it was free. */
function costText(known: number, unknownTurns: number, knownTurns: number): string {
  if (!knownTurns) return '';
  return unknownTurns ? `${dollars(known)}+` : dollars(known);
}

/** Turns whose vendor reported no token counts leave the figure out, not 0. */
function tokensText(tokens: number, turns: number): string {
  return turns && !tokens ? '' : compactCount(tokens);
}

export interface UsageDay { day: string; turns: number; tokens: number; costUsd: number; costTurns: number; unknownCostTurns: number }

/** The last `days` days, newest first, from the turn log and its per-day
 * rollups (invocationRollups: folded records keep tokens but no cost, so
 * their cost is unknown). A day with nothing recorded is listed as such. */
export function usageDays(state: HarnessState, now: number = Date.now(), days = 7): UsageDay[] {
  const table = new Map<string, UsageDay>();
  for (let back = 0; back < days; back += 1) {
    const day = localDay(now - back * DAY_MS);
    table.set(day, { day, turns: 0, tokens: 0, costUsd: 0, costTurns: 0, unknownCostTurns: 0 });
  }
  for (const invocation of state.invocations) {
    const row = table.get(localDay(Date.parse(invocation.at)));
    if (!row) continue;
    row.turns += 1;
    row.tokens += tokenCount(invocation);
    if (invocation.costUsd !== undefined) { row.costUsd += invocation.costUsd; row.costTurns += 1; } else row.unknownCostTurns += 1;
  }
  // Rollups are per UTC day: well past the raw retention, so never within
  // this week in practice, but counted where they fall when they are.
  for (const rollup of invocationRollups(state)) {
    const row = table.get(rollup.day);
    if (!row) continue;
    row.turns += rollup.calls;
    row.tokens += rollup.inputTokens + rollup.outputTokens;
    row.unknownCostTurns += rollup.calls;
  }
  return [...table.values()];
}

/** `/usage all`: every provider with an account or recorded use -- its
 * accounts' allowances and its totals -- then the last seven days. */
export function usageReportAll(
  state: HarnessState, session: HarnessSession, options: { now?: number; providerName?: (provider: string) => string } = {},
): { text: string } {
  const now = options.now ?? Date.now();
  const name = options.providerName ?? ((provider: string) => provider);
  const providers = [...new Set([...state.accounts.map((account) => account.provider), ...state.invocations.map((item) => item.provider)])]
    .sort((left, right) => name(left).localeCompare(name(right)));
  const sections = providers.map((provider) => {
    const accounts = state.accounts.filter((account) => account.provider === provider);
    const totals = sumInvocations(state.invocations.filter((item) => item.provider === provider));
    const unknown = state.invocations.filter((item) => item.provider === provider && item.costUsd === undefined).length;
    const cost = costText(totals.costUsd, unknown, totals.turns - unknown);
    return [
      name(provider),
      ...accounts.flatMap((account) => {
        const quota = allowance(account, state, now);
        const label = account.id === session.accountId ? `${account.label} · current` : account.label;
        return [`  ${label}${quota.label === 'not reported yet' ? '' : ` · ${quota.label}`}${quota.reset ? ` · ${quota.reset}` : ''}`];
      }),
      `  ${[`${totals.turns} ${totals.turns === 1 ? 'turn' : 'turns'}`, tokensText(totals.totalTokens, totals.turns), cost].filter(Boolean).join(' · ')}`,
    ].join('\n');
  });
  // Only the days with use: an idle day is a row saying nothing.
  const days = usageDays(state, now).filter((row) => row.turns);
  const width = Math.max(0, ...days.map((row) => tokensText(row.tokens, row.turns).length));
  const week = days.map((row) => {
    // Spelled out, not toLocaleDateString: the same on every machine.
    const date = new Date(`${row.day}T12:00:00`);
    const label = `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}`;
    const cost = costText(row.costUsd, row.unknownCostTurns, row.costTurns);
    const figures = [...(width ? [tokensText(row.tokens, row.turns).padStart(width)] : []), `${row.turns} ${row.turns === 1 ? 'turn' : 'turns'}`, ...(cost ? [cost] : [])];
    return `  ${label.padEnd(11)}  ${figures.join(' · ')}`;
  });
  return { text: [...(sections.length ? sections : ['No providers yet']), ['Last 7 days', ...(week.length ? week : ['  Nothing recorded'])].join('\n')].join('\n\n') };
}

/** `/usage`: quota, tokens, and cost for the provider you are in; `/usage
 * all` for every provider and the last seven days. */

import { isClikCodeAgent } from '../../session/route.js';
import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { compactCount, dollars } from '../../harness/protocol/format.js';
import { invocationRollups, invocationTokenCount } from '../../session/state/invocations.js';
import { accountBackAt, accountQuotaSpent, accountUsageText, outOfUsageText, usageResetLabel } from '../../harness/accounts/usage-reading.js';
import { costSplitParts } from '../render/usage-words.js';
import { accountUsage } from '../../session/picker-rows.js';
import { compactSetting } from '../../turn/compaction.js';
import { lossRate, searchRate, tunedModels } from '../../turn/context-tune.js';
import { periodKey, tuneSaving, usageByPeriod, type UsagePeriod, type UsagePeriodRow } from '../../session/usage-periods.js';

type Invocation = HarnessState['invocations'][number];

interface UsageReportTotals {
  accounts: number;
  turns: number;
  maintenance: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  costKnown: boolean;
  /** Only the turns that carry a split; absent when none does. */
  breakdown?: { meteredUsd: number; gpuUsd: number };
}

function sumInvocations(invocations: readonly Invocation[]): UsageReportTotals {
  return invocations.reduce<UsageReportTotals>((total, invocation) => ({
    accounts: total.accounts,
    turns: total.turns + (invocation.kind === 'maintenance' ? 0 : 1),
    maintenance: total.maintenance + (invocation.kind === 'maintenance' ? 1 : 0),
    inputTokens: total.inputTokens + (invocation.inputTokens ?? 0),
    outputTokens: total.outputTokens + (invocation.outputTokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (invocation.cacheReadTokens ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (invocation.cacheWriteTokens ?? 0),
    totalTokens: total.totalTokens + invocationTokenCount(invocation),
    costUsd: total.costUsd + (invocation.costUsd ?? 0),
    costKnown: total.costKnown || invocation.costUsd !== undefined,
    ...(invocation.costBreakdown || total.breakdown ? { breakdown: {
      meteredUsd: (total.breakdown?.meteredUsd ?? 0) + (invocation.costBreakdown?.meteredUsd ?? 0),
      gpuUsd: (total.breakdown?.gpuUsd ?? 0) + (invocation.costBreakdown?.gpuUsd ?? 0),
    } } : {}),
  }), { accounts: 0, turns: 0, maintenance: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, costKnown: false });
}

function allowance(account: AiHarnessAccount, state: HarnessState, now: number): { label: string; reset?: string } {
  const usage = accountUsage(account, state, now);
  const label = usage && accountUsageText(usage);
  if (usage && label) {
    const reset = usageResetLabel(usage.windows, now);
    return { label, ...(reset ? { reset } : {}) };
  }
  if (account.status === 'needs_login') return { label: 'needs reauthentication' };
  if (accountQuotaSpent(account, now)) return { label: outOfUsageText(accountBackAt(account, now), now) };
  return { label: 'not reported yet' };
}

function accountLines(account: AiHarnessAccount, state: HarnessState, session: HarnessSession, now: number): string[] {
  const totals = sumInvocations(state.invocations.filter((item) => item.accountId === account.id));
  const quota = allowance(account, state, now);
  const name = account.id === session.accountId ? `${account.label} · current` : account.label;
  const figures = [tokenFigure(totals.totalTokens), ...(totals.maintenance ? [`${totals.maintenance} cache refresh${totals.maintenance === 1 ? '' : 'es'}`] : [])];
  if (totals.costKnown) figures.push(dollars(totals.costUsd));
  const shown = figures.filter(Boolean);
  return [
    `  ${name}`,
    ...(quota.label === 'not reported yet' ? [] : [`  ${quota.label}`]),
    ...(quota.reset ? [`  ${quota.reset}`] : []),
    ...(shown.length ? [`  ${shown.join(' · ')}`] : []),
  ];
}

/** `12k tokens`, or nothing: a vendor that reports no token counts leaves
 * the figure out, never a bare `0` that reads as nothing used. */
function tokenFigure(tokens: number): string {
  return tokens ? `${compactCount(tokens)} tokens` : '';
}

function splitLines(totals: UsageReportTotals, cacheWithinInput: boolean): string[] {
  const flow = [
    ...(totals.inputTokens ? [`${compactCount(totals.inputTokens)} in${cacheWithinInput && totals.cacheReadTokens ? ' (includes cached)' : ''}`] : []),
    ...(totals.outputTokens ? [`${compactCount(totals.outputTokens)} out`] : []),
  ];
  const lines = flow.length ? [`  ${flow.join(' · ')}`] : [];
  if (totals.cacheReadTokens > 0) lines.push(`  ${compactCount(totals.cacheReadTokens)} cached${cacheWithinInput ? ' within input' : ''}`);
  if (totals.cacheWriteTokens > 0) lines.push(`  ${compactCount(totals.cacheWriteTokens)} cache written`);
  return lines;
}

/** What this conversation has cost in dollars, as /usage's "This chat"
 * adds it up; undefined when no turn of it reported a cost (a subscription
 * harness), which is not $0. */
export function conversationCost(state: Pick<HarnessState, 'invocations'>, sessionId: string): number | undefined {
  const totals = sumInvocations(state.invocations.filter((item) => item.sessionId === sessionId));
  return totals.costKnown ? totals.costUsd : undefined;
}

/** The API and GPU split of this conversation's cost, over the turns that
 * report one; undefined when none does. Never inferred for the others. */
export function conversationCostBreakdown(state: Pick<HarnessState, 'invocations'>, sessionId: string): { meteredUsd: number; gpuUsd: number } | undefined {
  return sumInvocations(state.invocations.filter((item) => item.sessionId === sessionId)).breakdown;
}

/** Ids that name this chat's provider. A session stores the catalog id
 * (`xai`) and sometimes only the command (`grok`). Accounts are filed under
 * the catalog id. Both have to match, for every harness, not one of them. */
function providerIds(session: HarnessSession, providerId?: string): Set<string> {
  return new Set([providerId, session.provider, session.nativeHarness].filter((id): id is string => Boolean(id)));
}

/** Quota and metered use for every account on the harness this chat is using,
 * then those figures added together, then this conversation. Nothing here
 * asks a vendor: a percentage is the last saved window,
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
  const chatBits = [`${conversation.turns} ${conversation.turns === 1 ? 'turn' : 'turns'}`, ...(conversation.maintenance ? [`${conversation.maintenance} cache refresh${conversation.maintenance === 1 ? '' : 'es'}`] : []), ...(conversation.totalTokens ? [tokenFigure(conversation.totalTokens)] : [])];
  const cost = conversationCost(state, session.id);
  if (cost !== undefined) chatBits.push(dollars(cost), ...costSplitParts(conversation.breakdown));
  const lines = [
    providerName,
    '',
    ...(accounts.length ? accounts.flatMap((account, index) => [...(index ? [''] : []), ...accountLines(account, state, session, now)]) : ['  No accounts on this provider']),
    '',
    ...(accounts.length === 1 ? [] : [`  ${totals.accounts} accounts · ${totals.turns} ${totals.turns === 1 ? 'turn' : 'turns'}${totals.maintenance ? ` · ${totals.maintenance} cache refresh${totals.maintenance === 1 ? '' : 'es'}` : ''}`]),
    ...splitLines(totals, providerInvocations.some((item) => item.provider === 'openai') && providerInvocations.every((item) => item.provider === 'openai')),
    ...(totals.costKnown && accounts.length !== 1 ? [`  ${dollars(totals.costUsd)}`] : []),
    '',
    `  This chat · ${chatBits.join(' · ')}`,
  ];
  // No blank row twice: a block that had nothing to say left its spacer.
  return { text: lines.filter((line, index) => line || lines[index - 1]).join('\n'), totals };
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

interface UsageDay { day: string; turns: number; maintenance: number; tokens: number; costUsd: number; costTurns: number; unknownCostTurns: number }

/** The last `days` days, newest first, from the turn log and its per-day
 * rollups (invocationRollups: folded records keep tokens but no cost, so
 * their cost is unknown). A day with nothing recorded is listed as such. */
export function usageDays(state: HarnessState, now: number = Date.now(), days = 7): UsageDay[] {
  const table = new Map<string, UsageDay>();
  for (let back = 0; back < days; back += 1) {
    const day = localDay(now - back * DAY_MS);
    table.set(day, { day, turns: 0, maintenance: 0, tokens: 0, costUsd: 0, costTurns: 0, unknownCostTurns: 0 });
  }
  for (const invocation of state.invocations) {
    const row = table.get(localDay(Date.parse(invocation.at)));
    if (!row) continue;
    row.turns += invocation.kind === 'maintenance' ? 0 : 1;
    row.maintenance += invocation.kind === 'maintenance' ? 1 : 0;
    row.tokens += invocationTokenCount(invocation);
    if (invocation.costUsd !== undefined) { row.costUsd += invocation.costUsd; row.costTurns += 1; } else row.unknownCostTurns += 1;
  }
  // Rollups are per UTC day: well past the raw retention, so never within
  // this week in practice, but counted where they fall when they are.
  for (const rollup of invocationRollups(state)) {
    const row = table.get(rollup.day);
    if (!row) continue;
    row.turns += rollup.calls - (rollup.maintenanceCalls ?? 0);
    row.maintenance += rollup.maintenanceCalls ?? 0;
    row.tokens += rollup.totalTokens ?? rollup.inputTokens + rollup.outputTokens;
    row.unknownCostTurns += rollup.calls;
  }
  return [...table.values()];
}

/** `/usage all`: every provider with an account or recorded use -- its
 * accounts' allowances and its totals -- then the last seven days. */
export function usageReportAll(
  state: HarnessState, session: Pick<HarnessSession, 'accountId'>, options: { now?: number; providerName?: (provider: string) => string } = {},
): { text: string } {
  const now = options.now ?? Date.now();
  const name = options.providerName ?? ((provider: string) => provider);
  const providers = [...new Set([...state.accounts.map((account) => account.provider), ...state.invocations.map((item) => item.provider)])]
    .sort((left, right) => name(left).localeCompare(name(right)));
  const sections = providers.map((provider) => {
    const accounts = state.accounts.filter((account) => account.provider === provider);
    const totals = sumInvocations(state.invocations.filter((item) => item.provider === provider));
    const unknown = state.invocations.filter((item) => item.provider === provider && item.costUsd === undefined).length;
    const cost = costText(totals.costUsd, unknown, totals.turns + totals.maintenance - unknown);
    return [
      name(provider),
      ...accounts.flatMap((account) => {
        const quota = allowance(account, state, now);
        const label = account.id === session.accountId ? `${account.label} · current` : account.label;
        return [`  ${label}${quota.label === 'not reported yet' ? '' : ` · ${quota.label}`}${quota.reset ? ` · ${quota.reset}` : ''}`];
      }),
      `  ${[`${totals.turns} ${totals.turns === 1 ? 'turn' : 'turns'}`, ...(totals.maintenance ? [`${totals.maintenance} cache refresh${totals.maintenance === 1 ? '' : 'es'}`] : []), tokensText(totals.totalTokens, totals.turns + totals.maintenance), cost].filter(Boolean).join(' · ')}`,
    ].join('\n');
  });
  // Only the days with use: an idle day is a row saying nothing.
  const days = usageDays(state, now).filter((row) => row.turns || row.maintenance);
  const width = Math.max(0, ...days.map((row) => tokensText(row.tokens, row.turns + row.maintenance).length));
  const week = days.map((row) => {
    // Spelled out, not toLocaleDateString: the same on every machine.
    const date = new Date(`${row.day}T12:00:00`);
    const label = `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}`;
    const cost = costText(row.costUsd, row.unknownCostTurns, row.costTurns);
    const figures = [...(width ? [tokensText(row.tokens, row.turns + row.maintenance).padStart(width)] : []), `${row.turns} ${row.turns === 1 ? 'turn' : 'turns'}`, ...(row.maintenance ? [`${row.maintenance} cache refresh${row.maintenance === 1 ? '' : 'es'}`] : []), ...(cost ? [cost] : [])];
    return `  ${label.padEnd(11)}  ${figures.join(' · ')}`;
  });
  const totals = usageTotalsText(state, { now, providerName: name });
  const tune = contextTuneText(state);
  return { text: [...(sections.length ? sections : ['No providers yet']), ['Last 7 days', ...(week.length ? week : ['  Nothing recorded'])].join('\n'), ...(totals ? [totals] : []), ...(tune ? [tune] : [])].join('\n\n') };
}

/** `−32%`: the share auto-tune saved, or nothing where no turn was measured. */
function savingText(rows: readonly UsagePeriodRow[]): string {
  const saving = tuneSaving(rows);
  if (!saving.measuredTokens) return '';
  const percent = Math.round(saving.savedShare * 100);
  return `without auto-tune ${compactCount(saving.withoutTuneTokens + (rows.reduce((sum, row) => sum + row.tokens, 0) - saving.measuredTokens))} (${percent > 0 ? `−${percent}` : percent === 0 ? '±0' : `+${-percent}`}%)`;
}

function accountName(state: Pick<HarnessState, 'accounts'>, accountId: string, provider: (id: string) => string, row?: UsagePeriodRow): string {
  const account = state.accounts.find((item) => item.id === accountId);
  return account ? `${provider(account.provider)} · ${account.label}` : `${provider(row?.provider ?? '')} · ${accountId.slice(0, 8)}`;
}

/** Per account: this hour, today, this week, this month, this year and everything recorded, then
 * what auto-tune saved over the turns it was measured on. */
export function usageTotalsText(state: HarnessState, options: { now?: number; providerName?: (provider: string) => string } = {}): string {
  const now = new Date(options.now ?? Date.now());
  const name = options.providerName ?? ((provider: string) => provider);
  const periods: Array<[UsagePeriod | 'all', string]> = [['hour', 'hour'], ['day', 'today'], ['week', 'week'], ['month', 'month'], ['year', 'year'], ['all', 'all']];
  const byPeriod = new Map(periods.map(([period]) => [period, period === 'all' ? usageByPeriod(state, 'year') : usageByPeriod(state, period)]));
  const accounts = [...new Set(byPeriod.get('all')!.map((row) => row.accountId))];
  if (!accounts.length) return '';
  const lines = accounts.map((accountId) => {
    const figures = periods.map(([period, label]) => {
      const rows = byPeriod.get(period)!.filter((row) => row.accountId === accountId && (period === 'all' || row.period === periodKey(now, period)));
      return `${label} ${compactCount(rows.reduce((sum, row) => sum + row.tokens, 0))}`;
    });
    const all = byPeriod.get('all')!.filter((row) => row.accountId === accountId);
    const saving = savingText(all);
    return [`  ${accountName(state, accountId, name, all[0])}`, `    ${figures.join(' · ')}`, ...(saving ? [`    ${saving}`] : [])].join('\n');
  });
  const everything = byPeriod.get('all')!;
  const saving = tuneSaving(everything);
  const summary = saving.measuredTokens
    ? `  Auto-tune saved ${compactCount(saving.savedTokens)} tokens (${Math.round(saving.savedShare * 100)}%) on the ${Math.round(saving.coverage * 100)}% of use measured -- an estimate against the vendor's default compaction`
    : '  Auto-tune: no turn measured yet (turns record their context readings from now on)';
  return ['Tokens by account', ...lines, '', summary].join('\n');
}

/** `clikcode usage --by <period>`: every account's use per period, newest first. */
export function usagePeriodText(state: HarnessState, period: UsagePeriod, options: { last?: number; providerName?: (provider: string) => string } = {}): string {
  const name = options.providerName ?? ((provider: string) => provider);
  const rows = usageByPeriod(state, period);
  const keys = [...new Set(rows.map((row) => row.period))].slice(0, options.last ?? 14);
  if (!keys.length) return 'Nothing recorded';
  const width = Math.max(...rows.map((row) => compactCount(row.tokens).length));
  return keys.map((key) => {
    const inPeriod = rows.filter((row) => row.period === key);
    const total = inPeriod.reduce((sum, row) => sum + row.tokens, 0);
    const head = [key, `${compactCount(total)} tokens`, savingText(inPeriod)].filter(Boolean).join(' · ');
    return [head, ...inPeriod.map((row) => {
      const cost = row.costTurns ? (row.costTurns < row.turns ? `${dollars(row.costUsd)}+` : dollars(row.costUsd)) : '';
      return `  ${compactCount(row.tokens).padStart(width)}  ${[accountName(state, row.accountId, name, row), `${row.turns} ${row.turns === 1 ? 'turn' : 'turns'}`, cost, savingText([row])].filter(Boolean).join(' · ')}`;
    })].join('\n');
  }).join('\n\n');
}

const k = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/** Where auto-tune has each model, what its turns show, and its last change (turn/context-tune.ts). */
export function contextTuneText(state: Pick<HarnessState, 'globalSettings'>): string {
  const setting = compactSetting(state.globalSettings);
  const models = tunedModels();
  if (setting === 'auto' && !models.length) return '';
  const head = setting === 'auto' ? 'Context auto-tune (/compact auto)'
    : setting === 'off' ? "Context auto-tune: off -- each vendor compacts at its own default (/compact auto turns it on)"
      : `Context auto-tune: off -- every model compacts at ${k(setting)} (/compact auto turns it on)`;
  const rows = models.map(({ harness, model, tune }) => {
    const rate = (counts: typeof tune.full): string => counts.turns
      ? `loss ${lossRate(counts).toFixed(2)}/turn, search ${searchRate(counts).toFixed(2)}/turn over ${counts.turns} turns` : 'no turns yet';
    const last = tune.log.at(-1);
    return [
      `  ${harness} · ${model || 'default model'} · ${k(tune.level)}${tune.confirmed !== undefined ? ` (last held ${k(tune.confirmed)})` : ''}`,
      `    whole context: ${rate(tune.full)}`,
      `    cut context:   ${rate(tune.cut)}`,
      ...(last ? [`    last change ${last.at.slice(0, 16).replace('T', ' ')}: ${last.from === last.to ? k(last.to) : `${k(last.from)} -> ${k(last.to)}`} -- ${last.why}`] : []),
    ].join('\n');
  });
  return [head, ...rows].join('\n');
}

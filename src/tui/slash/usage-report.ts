/** `/usage`: quota, tokens, and cost for the provider you are in. */

import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { learnedUsageReading } from '../../harness/accounts/usage-learning.js';
import { usageReadingIsCurrent, usageResetLabel, type AccountUsageReading, type UsageWindow } from '../../harness/accounts/usage-reading.js';

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
  return invocations.reduce((total, invocation) => ({
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

function money(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** 7,166,839 becomes 7.2M. A full comma-separated count is what wrapped
 * mid-number on a phone. */
function compact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) {
    const scaled = abs / 1_000_000;
    return `${sign}${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (abs >= 1_000) {
    const scaled = abs / 1_000;
    return `${sign}${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(scaled >= 10 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return value.toLocaleString('en-US');
}

function allowance(account: AiHarnessAccount, state: HarnessState, now: number): { label: string; reset?: string } {
  const stored = account.usage as AccountUsageReading | undefined;
  const windows = stored?.windows ?? [];
  const current: readonly UsageWindow[] | undefined = windows.length > 0 && usageReadingIsCurrent({ windows }, now) ? windows : undefined;
  if (current?.length) {
    const label = current.map((window) => `${window.name} ${Math.max(0, Math.min(100, Math.round(100 - window.usedPct)))}% left`).join(' · ');
    return { label, ...(usageResetLabel(current, now) ? { reset: usageResetLabel(current, now) } : {}) };
  }
  const learned = learnedUsageReading(account.usageLearning, state.invocations, account.id, now);
  if (learned?.label) {
    return { label: `${learned.label} · learned`, ...(usageResetLabel(learned.windows, now) ? { reset: usageResetLabel(learned.windows, now) } : {}) };
  }
  if (stored?.label && stored.failed !== true && windows.length === 0) return { label: stored.label };
  if (account.status === 'needs_login') return { label: 'needs reauthentication' };
  if (account.quotaState === 'exhausted') return { label: 'out of usage' };
  return { label: 'not reported yet' };
}

function accountLines(account: AiHarnessAccount, state: HarnessState, session: HarnessSession, now: number): string[] {
  const totals = sumInvocations(state.invocations.filter((item) => item.accountId === account.id));
  const quota = allowance(account, state, now);
  const name = account.id === session.accountId ? `${account.label} · current` : account.label;
  const figures = [compact(totals.totalTokens)];
  if (totals.costKnown) figures.push(money(totals.costUsd));
  return [
    `  ${name}`,
    ...(quota.label === 'not reported yet' ? [] : [`  ${quota.label}`]),
    ...(quota.reset ? [`  ${quota.reset}`] : []),
    `  ${figures.join(' · ')}`,
  ];
}

function splitLines(totals: UsageReportTotals): string[] {
  const flow = [`${compact(totals.inputTokens)} in`, `${compact(totals.outputTokens)} out`];
  const lines = [`  ${flow.join(' · ')}`];
  if (totals.cacheReadTokens > 0) lines.push(`  ${compact(totals.cacheReadTokens)} cached`);
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
  const accounts = session.route === 'gateway' ? [] : state.accounts.filter((account) => ids.has(account.provider));
  const accountIds = new Set(accounts.map((account) => account.id));
  const providerInvocations = state.invocations.filter((item) => accountIds.has(item.accountId) || ids.has(item.provider));
  const totals = { ...sumInvocations(providerInvocations), accounts: accounts.length };
  const conversation = sumInvocations(state.invocations.filter((item) => item.sessionId === session.id));
  const chatBits = [`${conversation.turns} ${conversation.turns === 1 ? 'turn' : 'turns'}`, compact(conversation.totalTokens)];
  if (conversation.costKnown) chatBits.push(money(conversation.costUsd));
  const lines = [
    providerName,
    '',
    ...(accounts.length ? accounts.flatMap((account, index) => [...(index ? [''] : []), ...accountLines(account, state, session, now)]) : ['  No accounts on this provider']),
    '',
    ...(accounts.length === 1 ? [] : [`  ${totals.accounts} accounts · ${totals.turns} ${totals.turns === 1 ? 'turn' : 'turns'}`]),
    ...splitLines(totals),
    ...(totals.costKnown && accounts.length !== 1 ? [`  ${money(totals.costUsd)}`] : []),
    '',
    `  This chat · ${chatBits.join(' · ')}`,
  ];
  return { text: lines.join('\n'), totals };
}

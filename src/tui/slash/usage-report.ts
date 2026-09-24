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

function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
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

function costLine(totals: UsageReportTotals): string {
  return totals.costKnown ? `$${totals.costUsd.toFixed(4)}` : 'not reported';
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

function accountBlock(account: AiHarnessAccount, state: HarnessState, session: HarnessSession, now: number): string[] {
  const invocations = state.invocations.filter((item) => item.accountId === account.id);
  const totals = sumInvocations(invocations);
  const quota = allowance(account, state, now);
  const name = account.id === session.accountId ? `${account.label} · current` : account.label;
  return [
    `  ${name}`,
    `    allowance  ${quota.label}`,
    ...(quota.reset ? [`    ${quota.reset}`] : []),
    `    turns      ${totals.turns}`,
    `    tokens     ${formatTokens(totals.totalTokens)}  (in ${formatTokens(totals.inputTokens)} · out ${formatTokens(totals.outputTokens)} · cached ${formatTokens(totals.cacheReadTokens)})`,
    `    cost       ${costLine(totals)}`,
  ];
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
  const lines = [
    providerName,
    `  accounts   ${totals.accounts}`,
    `  turns      ${totals.turns}`,
    `  input      ${formatTokens(totals.inputTokens)} tokens`,
    `  cached     ${formatTokens(totals.cacheReadTokens)} tokens`,
    `  output     ${formatTokens(totals.outputTokens)} tokens`,
    `  total      ${formatTokens(totals.totalTokens)} tokens`,
    `  cost       ${costLine(totals)}`,
    '',
    'Accounts',
    ...(accounts.length ? accounts.flatMap((account) => accountBlock(account, state, session, now)) : ['  none on this provider']),
    '',
    'This conversation',
    `  turns      ${conversation.turns}`,
    `  tokens     ${formatTokens(conversation.totalTokens)}`,
    `  cost       ${costLine(conversation)}`,
  ];
  return { text: lines.join('\n'), totals };
}

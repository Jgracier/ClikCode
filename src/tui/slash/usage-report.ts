/** `/usage`: quota, tokens, and cost for the provider you are in. */

import { isClikCodeAgent } from '../../session/route.js';
import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { compactCount, dollars } from '../../harness/protocol/format.js';
import { learnedReading } from '../../harness/accounts/learned-usage.js';
import { accountQuotaSpent, usageReadingIsCurrent, vendorWindows, usageResetLabel, usageWindowTitle, type AccountUsageReading, type UsageWindow } from '../../harness/accounts/usage-reading.js';

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
  const stored = account.usage as AccountUsageReading | undefined;
  const windows = vendorWindows(account);
  const current: readonly UsageWindow[] | undefined = windows.length > 0 && usageReadingIsCurrent({ windows }, now) ? windows : undefined;
  if (current?.length) {
    const label = current.map((window) => `${usageWindowTitle(window.name)} ${Math.max(0, Math.min(100, Math.round(100 - window.usedPct)))}% left`).join(' · ');
    return { label, ...(usageResetLabel(current, now) ? { reset: usageResetLabel(current, now) } : {}) };
  }
  const learned = learnedReading(state, account, now);
  if (learned?.label) {
    const reset = usageResetLabel(learned.windows, now);
    return { label: `${learned.label} · estimated`, ...(reset ? { reset } : {}) };
  }
  // A balance: a label with no windows (Auggie, Amp, Kilo).
  if (stored?.label && !stored.failed && !stored.windows?.length) return { label: stored.label };
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

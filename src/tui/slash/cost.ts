/** `/cost` and the context-window line: tokens counted and priced. */

import { stdin as input, stdout as output } from 'node:process';
import type { HarnessSession, HarnessState } from '../../harness/types.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { sessionHarness } from './context.js';

function formatTokens(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString('en-US');
}

export function contextUsageText(session: HarnessSession): string {
  const usage = session.lastUsage;
  const who = session.route === 'gateway' ? 'ClikDeploy Gateway' : sessionHarness(session)?.displayName ?? 'The provider';
  if (!usage) return `${who} has not reported token usage for this conversation yet. It appears here after a turn on a harness that publishes usage events.`;
  const used = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || undefined);
  const window = usage.contextWindow;
  return [
    `Context usage (as of ${usage.at})`,
    window && used !== undefined ? `  window     ${formatTokens(used)} / ${formatTokens(window)} tokens (${Math.min(100, Math.round((used / window) * 100))}%)` : `  window     not reported by ${who}`,
    `  input      ${formatTokens(usage.inputTokens)}`,
    `  cached     ${formatTokens(usage.cacheReadTokens)}`,
    `  output     ${formatTokens(usage.outputTokens)}`,
    `  total      ${formatTokens(used)}`,
    `  messages   ${sessionTranscriptMessages(session).length}`,
  ].join('\n');
}

export function costReport(state: HarnessState, session: HarnessSession): { text: string; totals: { turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; costKnown: boolean } } {
  const invocations = state.invocations.filter((item) => item.sessionId === session.id);
  const totals = invocations.reduce((sum, item) => ({
    turns: sum.turns + 1, inputTokens: sum.inputTokens + (item.inputTokens ?? 0), outputTokens: sum.outputTokens + (item.outputTokens ?? 0),
    cacheReadTokens: sum.cacheReadTokens + (item.cacheReadTokens ?? 0), costUsd: sum.costUsd + (item.costUsd ?? 0),
    costKnown: sum.costKnown || item.costUsd !== undefined,
  }), { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, costKnown: false });
  const text = invocations.length
    ? [
      'This conversation',
      `  turns      ${totals.turns}`,
      `  input      ${formatTokens(totals.inputTokens)} tokens`,
      `  cached     ${formatTokens(totals.cacheReadTokens)} tokens`,
      `  output     ${formatTokens(totals.outputTokens)} tokens`,
      `  cost       ${totals.costKnown ? `$${totals.costUsd.toFixed(4)}` : 'not reported (subscription plans and most vendor CLIs do not publish a price)'}`,
    ].join('\n')
    : 'No metered turns recorded for this conversation yet.';
  return { text, totals };
}

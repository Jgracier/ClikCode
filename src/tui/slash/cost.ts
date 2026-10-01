/** `/cost` and the context-window line: tokens counted and priced. */

import { clikCodeAgentLabel, isClikCodeAgent } from '../../session/route.js';
import type { HarnessSession } from '../../session/model.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { sessionHarness } from './context.js';

function formatTokens(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString('en-US');
}

export function contextUsageText(session: HarnessSession): string {
  const usage = session.lastUsage;
  const who = isClikCodeAgent(session) ? clikCodeAgentLabel(session) : sessionHarness(session)?.displayName ?? 'The provider';
  if (!usage) return `${who} has not reported token usage for this conversation yet. It appears here after a turn on a harness that publishes usage events.`;
  const used = usage.contextUsed ?? usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0) || undefined);
  const window = usage.contextWindow;
  return [
    `Context usage (as of ${usage.at})`,
    window && used !== undefined ? `  window     ${formatTokens(used)} / ${formatTokens(window)} tokens (${Math.min(100, Math.round((used / window) * 100))}%)` : `  window     not reported by ${who}`,
    `  input      ${formatTokens(usage.input)}`,
    `  cached     ${formatTokens(usage.cacheRead)}`,
    `  output     ${formatTokens(usage.output)}`,
    `  total      ${formatTokens(usage.totalTokens ?? used)}`,
    `  messages   ${sessionTranscriptMessages(session).length}`,
  ].join('\n');
}

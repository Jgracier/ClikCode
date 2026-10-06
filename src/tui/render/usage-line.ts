/** One line of token usage, compacted. */

import { compactCount, dollars } from '../../harness/protocol/format.js';
import type { TurnUsage } from '../../harness/protocol/turn-usage.js';

/** `↑ 1.2k ↓ 340 tokens · 37k cached · 48k/200k context · $0.02`: what the
 * harness reported for a turn, each part only once it is known. Empty before
 * there is anything to count. VS Code shows it under the composer once a turn
 * has ended. */
export function formatTurnUsage(usage?: TurnUsage): string {
  const output = usage?.output ?? 0;
  const flow = [
    ...(usage?.input ? [`↑ ${compactCount(usage.input)}`] : []),
    ...(output ? [`↓ ${compactCount(output)}`] : []),
  ];
  const parts = [
    ...(flow.length ? [`${flow.join(' ')} tokens`] : []),
    ...(usage?.cacheRead ? [`${compactCount(usage.cacheRead)} cached`] : []),
    ...(usage?.contextUsed ? [`${compactCount(usage.contextUsed)}${usage.contextWindow ? `/${compactCount(usage.contextWindow)}` : ''} context`]
      : usage?.contextPercent ? [`${usage.contextPercent < 10 ? usage.contextPercent.toFixed(1) : Math.round(usage.contextPercent)}% context`] : []),
    ...(usage?.costUsd ? [dollars(usage.costUsd)] : []),
    ...(usage?.credits ? [`${usage.credits < 1 ? usage.credits.toFixed(3) : usage.credits.toFixed(2)} credits`] : []),
  ];
  return parts.join(' · ');
}

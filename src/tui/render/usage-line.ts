/** One line of token usage, compacted. */

import type { TurnUsage } from '../../harness/protocol/turn-usage.js';

const compactCount = (count: number): string => (count < 1000 ? String(count)
  : count < 1_000_000 ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k` : `${(count / 1_000_000).toFixed(1)}M`);

const dollars = (amount: number): string => `$${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`;

/** `↑ 1.2k ↓ 340 tokens · 37k cached · 48k/200k context · $0.02`: what the
 * harness has reported so far, each part only once it is known. Empty before
 * the harness reports anything. */
export function formatTurnUsage(usage?: TurnUsage): string {
  if (!usage) return '';
  const flow = [
    ...(usage.input ? [`↑ ${compactCount(usage.input)}`] : []),
    ...(usage.output ? [`↓ ${compactCount(usage.output)}`] : []),
  ];
  const parts = [
    ...(flow.length ? [`${flow.join(' ')} tokens`] : []),
    ...(usage.cacheRead ? [`${compactCount(usage.cacheRead)} cached`] : []),
    ...(usage.contextUsed ? [`${compactCount(usage.contextUsed)}${usage.contextWindow ? `/${compactCount(usage.contextWindow)}` : ''} context`] : []),
    ...(usage.costUsd ? [dollars(usage.costUsd)] : []),
  ];
  return parts.join(' · ');
}

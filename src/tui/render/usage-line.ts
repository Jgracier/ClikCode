/** One line of token usage, compacted. */

import type { TurnUsage } from '../../harness/protocol/turn-usage.js';

const compactCount = (count: number): string => (count < 1000 ? String(count)
  : count < 1_000_000 ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k` : `${(count / 1_000_000).toFixed(1)}M`);

const dollars = (amount: number): string => `$${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`;

/** Streamed text is roughly four characters a token. Only ever shown marked
 * as an estimate, and only until the vendor's own count covers it. */
export function estimatedTokens(characters: number): number {
  return Math.ceil(Math.max(0, characters) / 4);
}

/** `↑ 1.2k ↓ 340 tokens · 37k cached · 48k/200k context · $0.02`: what the
 * harness has reported so far, each part only once it is known. Empty before
 * there is anything to count. `estimatedOutput` is what has streamed since
 * the vendor last reported output tokens; while it is non-zero the output
 * figure is marked `~`. */
export function formatTurnUsage(usage?: TurnUsage, estimatedOutput = 0): string {
  const output = (usage?.output ?? 0) + estimatedOutput;
  const flow = [
    ...(usage?.input ? [`↑ ${compactCount(usage.input)}`] : []),
    ...(output ? [`↓ ${estimatedOutput ? '~' : ''}${compactCount(output)}`] : []),
  ];
  const parts = [
    ...(flow.length ? [`${flow.join(' ')} tokens`] : []),
    ...(usage?.cacheRead ? [`${compactCount(usage.cacheRead)} cached`] : []),
    ...(usage?.contextUsed ? [`${compactCount(usage.contextUsed)}${usage.contextWindow ? `/${compactCount(usage.contextWindow)}` : ''} context`] : []),
    ...(usage?.costUsd ? [dollars(usage.costUsd)] : []),
  ];
  return parts.join(' · ');
}

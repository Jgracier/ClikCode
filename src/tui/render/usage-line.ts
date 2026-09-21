/** One line of token usage, compacted. */



const compactCount = (count: number): string => (count < 1000 ? String(count)
  : count < 1_000_000 ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k` : `${(count / 1_000_000).toFixed(1)}M`);

/** `↑ 1.2k ↓ 340 tokens`, or an empty string before the harness reports any. */
export function formatTurnUsage(usage?: { inputTokens?: number; outputTokens?: number }): string {
  const parts = [
    ...(usage?.inputTokens ? [`↑ ${compactCount(usage.inputTokens)}`] : []),
    ...(usage?.outputTokens ? [`↓ ${compactCount(usage.outputTokens)}`] : []),
  ];
  return parts.length ? `${parts.join(' ')} tokens` : '';
}

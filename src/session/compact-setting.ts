/** `/settings global compact <size>`: how large a conversation's live context may grow before
 * ClikCode compacts it. A global user setting (globalSettings.compactAt, in tokens; absent means
 * the default, 0 means off). Chalk free and dependency free, so the webview bundle can import it.
 *
 * WHY 250k. Every step of an agent loop re-reads the whole context from the provider's cache, so a
 * step costs in proportion to the context. MEASURED on the user's own log (817 Claude turns in 8
 * days): 5.2 billion cache-read tokens, a median turn reading 1.5M, the p90 turn 16.7M, the
 * busiest turn 151M, and one chat compacted at 682k tokens. Compacting is itself one long call
 * (read the context once, write a ~15-20k summary, cache the ~30-40k that remains), about as much
 * as 6 steps at 250k. After it, each step reads ~35k instead of 250k, so it has paid for itself
 * within ~6 steps -- under half of a median turn at that size, and a long loop runs dozens. Lower
 * (150k) saves less per compaction and compacts twice as often, each time losing detail the
 * summary drops; higher (500k+) pays 2-4x more per step while it waits. 250k sits past the point
 * where compaction repays itself within a turn and short of the sizes that dominate the bill. */

/** Tokens of live context at which a finished turn is followed by a compaction. */
export const DEFAULT_COMPACT_AT_TOKENS = 250_000;
/** Never act below this: a small context is cheap to re-read and a compaction costs more than it saves. */
export const MIN_COMPACT_AT_TOKENS = 50_000;
/** The share of the model's window past which the vendor compacts by itself anyway; ours acts before it. */
export const COMPACT_WINDOW_SHARE = 0.8;

/** A size typed as `250000`, `250k`, `1m` or `0.5m`; `off` (or 0) is 0, `default` is undefined. */
export function parseCompactAt(word: string): number | undefined {
  const text = word.trim().toLowerCase();
  if (text === 'default' || text === 'auto') return undefined;
  if (text === 'off' || text === 'never' || text === 'no' || text === 'false') return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)(?:\s*tokens?)?$/.exec(text);
  if (!match) throw new Error('usage: /settings global compact <tokens, such as 250k or 1m | off | default>');
  const tokens = Math.round(Number(match[1]) * (match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1));
  if (tokens !== 0 && tokens < MIN_COMPACT_AT_TOKENS) throw new Error(`compact must be at least ${MIN_COMPACT_AT_TOKENS / 1000}k tokens, or off`);
  return tokens;
}

/** The size the user's setting means: tokens, or undefined for off. Limited to the model's window
 * when it is known -- a threshold past it would never be reached before the vendor compacts. */
export function compactThreshold(settings: { compactAt?: unknown } | undefined, contextWindow?: number): number | undefined {
  const set = settings?.compactAt;
  const configured = typeof set === 'number' && Number.isFinite(set) && set >= 0 ? set : DEFAULT_COMPACT_AT_TOKENS;
  if (configured === 0) return undefined;
  if (!contextWindow || contextWindow <= 0) return configured;
  return Math.max(MIN_COMPACT_AT_TOKENS, Math.min(configured, Math.floor(contextWindow * COMPACT_WINDOW_SHARE)));
}

export function compactAtLabel(settings: { compactAt?: unknown } | undefined): string {
  const set = settings?.compactAt;
  if (set === 0) return 'off';
  const tokens = typeof set === 'number' && set > 0 ? set : DEFAULT_COMPACT_AT_TOKENS;
  return `${tokens >= 1_000_000 ? `${tokens / 1_000_000}m` : `${Math.round(tokens / 1000)}k`} tokens${set === undefined ? ' (default)' : ''}`;
}

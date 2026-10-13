/** Compacting the conversation in place, for the loop's size check and a step's recovery. */
import { compactConversation, estimateContextTokens, MAX_REQUEST_ITEMS } from './context.js';
import { isTurnCancelled } from './cancellation.js';
import { recordUsage } from './usage.js';
import { abortable } from './turn-support.js';
import type { TurnRuntime } from './turn-runtime.js';

/** Compacts the conversation in place; false when there was nothing to
 * compact. Saved, and its own model usage counted, like any step. */
export async function compactTurn(
  rt: TurnRuntime, system: string, targetTokens?: number,
  /** Why: this agent compacts only itself, as it nears the window or when the
   * server refuses a request as too large, so the trigger is always 'auto'
   * (hooks.ts); named here so a caller that compacts for another reason says so. */
  trigger: 'auto' | 'manual' = 'auto',
): Promise<boolean> {
  const { input, signal } = rt;
  input.onPhase?.('compacting context');
  if (!input.subagent && input.hooks?.preCompact) await abortable(input.hooks.preCompact({ ...rt.turnHookInfo, trigger }), signal);
  let compacted: Awaited<ReturnType<typeof compactConversation>>;
  try {
    compacted = await abortable(compactConversation({ items: rt.items, modelClient: input.modelClient, signal, system, maxItems: MAX_REQUEST_ITEMS, ...(targetTokens !== undefined ? { targetTokens } : {}) }), signal);
  } catch (error) {
    // Cancel ends the turn. Any other failure of the summarising call
    // leaves the conversation as it was: the step that follows has its own
    // recovery if the context really does not fit.
    if (isTurnCancelled(error) || signal?.aborted) throw error;
    input.onPhase?.(`compaction failed (${error instanceof Error ? error.message : String(error)}); continuing`);
    return false;
  }
  // The summarising call was paid for whatever came of it.
  if (compacted.usage) rt.ledger = recordUsage(rt.ledger, compacted.usage);
  if (compacted.stage === 'none') return false;
  rt.items = compacted.items;
  rt.lastStepUsage = undefined;
  rt.tokensAfterCompaction = estimateContextTokens(system, rt.items);
  if (compacted.stage === 'summarized') await rt.store.appendCompaction(compacted.summary!, compacted.kept!);
  return true;
}

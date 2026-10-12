/** Compacting the conversation in place, for the loop's size check and a step's recovery. */
import { compactConversation, MAX_REQUEST_ITEMS } from './context.js';
import { isTurnCancelled } from './cancellation.js';
import { recordUsage } from './usage.js';
import { abortable } from './turn-support.js';
import type { TurnRuntime } from './turn-runtime.js';

/** Compacts the conversation in place; false when there was nothing to
 * compact. Saved, and its own model usage counted, like any step. */
export async function compactTurn(rt: TurnRuntime, system: string, targetTokens?: number): Promise<boolean> {
  const { input, signal } = rt;
  input.onPhase?.('compacting context');
  if (!input.subagent && input.hooks?.preCompact) await abortable(input.hooks.preCompact({ ...rt.turnHookInfo, trigger: 'auto' }), signal);
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
  if (compacted.stage === 'none') return false;
  rt.items = compacted.items;
  rt.lastStepUsage = undefined;
  if (compacted.stage === 'summarized') await rt.store.appendCompaction(compacted.summary!, compacted.kept!);
  if (compacted.usage) rt.ledger = recordUsage(rt.ledger, { step: rt.steps, usage: compacted.usage });
  return true;
}

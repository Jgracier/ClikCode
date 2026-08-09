// ============================================
// AI PROVIDER REGISTRY — per-model token limits / reasoning effort
// ============================================

import { DEFAULT_CONTEXT_WINDOW, type AiModelTokenLimits, type AiReasoningEffort } from './types';
import { getAiProvider } from './lookups';

export function modelTokenLimits(provider: string, model: string): AiModelTokenLimits {
  const spec = getAiProvider(provider);
  if (!spec) return { contextWindow: DEFAULT_CONTEXT_WINDOW };
  const id = String(model || '').trim();
  let best: { prefix: string; limits: { contextWindow: number; maxOutput?: number } } | null = null;
  for (const [prefix, limits] of Object.entries(spec.modelWindows ?? {})) {
    if (!id.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, limits };
  }
  const contextWindow = best?.limits.contextWindow ?? spec.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutput = best?.limits.maxOutput ?? spec.maxOutput;
  return {
    contextWindow,
    ...(maxOutput !== undefined ? { maxOutput } : {}),
  };
}

/**
 * Default reasoning effort for a provider+model pair, or `undefined` when the model is not
 * declared reasoning-capable (in which case the caller must NOT send the parameter — see
 * `modelWindows`'s doc comment on why absence is load-bearing, not just an unset default).
 * Same longest-prefix-match convention as `modelTokenLimits`.
 */
export function modelReasoningEffort(provider: string, model: string): AiReasoningEffort | undefined {
  const spec = getAiProvider(provider);
  if (!spec) return undefined;
  const id = String(model || '').trim();
  let best: { prefix: string; effort: AiReasoningEffort } | null = null;
  for (const [prefix, limits] of Object.entries(spec.modelWindows ?? {})) {
    if (!id.startsWith(prefix) || !limits.reasoningEffort) continue;
    if (!best || prefix.length > best.prefix.length) {
      best = { prefix, effort: limits.reasoningEffort };
    }
  }
  return best?.effort;
}


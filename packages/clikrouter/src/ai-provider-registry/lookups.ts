// ============================================
// AI PROVIDER REGISTRY — lookups
// ============================================

import type { AiProviderSpec } from './types';
import { AI_PROVIDERS } from './providers';

/** Look up a provider spec by id (undefined when unknown). */
export function getAiProvider(id: string): AiProviderSpec | undefined {
  return (AI_PROVIDERS as readonly AiProviderSpec[]).find((p) => p.id === id);
}

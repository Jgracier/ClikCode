// ============================================
// AI PROVIDER REGISTRY (pure data — client-safe)
// ============================================
// The single source of truth for every AI provider this router knows about.
// Implementation lives in ./ai-provider-registry/*; this file is a stable barrel
// so existing imports of ./ai-provider-registry keep working without churn.
//
// CRITICAL: this module is exported from the CLIENT-SAFE root barrel and is
// imported by 'use client' components. It must stay pure data + pure helpers —
// no db/redis/env access, no server-only imports.

export * from './ai-provider-registry/types';
export * from './ai-provider-registry/providers';
export * from './ai-provider-registry/lookups';
export * from './ai-provider-registry/model-limits';

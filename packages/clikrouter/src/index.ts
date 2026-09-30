// ============================================
// CLIKROUTER — ClikCode's harness catalog and its direct API-key route
// ============================================
// The harness catalog (ai-local-harness), the provider registry the direct
// route reads, and the AI SDK turn that serves it (ai-provider-models).
// ClikCode imports the subpaths; scripts/build.mjs bundles them into
// dist/harness-catalog.cjs and dist/ai-router-runtime.cjs.

export * from './ai-provider-registry-public';
export * from './ai-provider-models';
export * from './ai-local-harness';

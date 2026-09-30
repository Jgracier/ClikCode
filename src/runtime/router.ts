/**
 * The direct API-key route's turn, bundled on its own as CommonJS
 * (dist/ai-router-runtime.cjs) because `ai` and the @ai-sdk providers are 3 MB
 * that only such a turn needs. The harness catalog is dist/harness-catalog.cjs
 * (catalog.ts); it is not repeated here.
 */
export { streamAiChatTurn } from '@clikcode/router/ai-provider-models';

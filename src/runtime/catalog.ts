/**
 * The harness catalog, bundled on its own (dist/harness-catalog.cjs): every
 * `doctor`, account and picker render and every brokered vendor turn reads it,
 * and none of them needs the AI SDK the direct route's turn carries
 * (router.ts). ai-local-harness and the provider registry are pure data and
 * functions; scripts/build.mjs fails the build if an AI SDK ever leaks in.
 * ALL catalog calls go through this one bundle: registerCustomHarnesses()
 * keeps module state that a second copy would not see.
 */
import type { AiRouterRuntime } from '../harness/definition.js';

export * from '@clikcode/router/ai-local-harness';

/** The provider registry's own lookup, for the one question the app cannot
 * answer from a harness definition alone: is this provider a model API we can
 * address directly, or is it a TOOL whose name merely sits in the same field?
 *
 * `aider`, `goose`, `opencode` and nine others name themselves as their
 * provider and have no endpoint of their own -- they talk to whichever model
 * vendor the user's key belongs to. Deciding that from the registry keeps one
 * source of truth; the alternative was a heuristic on the harness definition,
 * and every such heuristic gets `vibe` (provider `mistral-vibe`) wrong.
 *
 * Pure data with no imports outside the registry, so it does not endanger this
 * bundle's dependency-free guarantee -- which the build asserts. */
export { getAiProvider } from '@clikcode/router/ai-provider-registry-public';

/** What dist/harness-catalog.cjs provides: everything except model streaming. */
export type HarnessCatalogRuntime = Omit<AiRouterRuntime, 'streamAiChatTurn'>;

/**
 * Catalog-only slice of the router runtime.
 *
 * router.ts also exports `streamAiChatTurn`, which pulls `ai` and
 * ~25 @ai-sdk providers (2.8 MB of CJS plus a native module). Harness catalog
 * lookups — every `doctor`, every account/picker render, every brokered vendor
 * turn — need none of that: ai-local-harness and the provider registry are
 * pure data and functions. scripts/build.mjs bundles this entry to
 * dist/harness-catalog.cjs and fails the build if an AI SDK ever leaks in.
 *
 * Every catalog export of router.ts is exported here under the same
 * name, so this is a drop-in for the catalog members of `AiRouterRuntime` (see
 * HarnessCatalogRuntime below).
 */
import type { AiRouterRuntime } from '../harness/definition.js';

// `export *`, not a name list: router.ts re-exports a growing subset
// of this module, and a wildcard is a superset of any such list by
// construction, so the two entries cannot drift apart. It also matters that ALL
// catalog calls go through one bundle: registerCustomHarnesses() keeps module
// state, and a second copy inside ai-router-runtime.cjs would not see it.
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

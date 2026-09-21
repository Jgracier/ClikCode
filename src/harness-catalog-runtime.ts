/**
 * Catalog-only slice of the router runtime.
 *
 * ai-router-runtime.ts also exports `streamAiChatTurn`, which pulls `ai` and
 * ~25 @ai-sdk providers (2.8 MB of CJS plus a native module). Harness catalog
 * lookups — every `doctor`, every account/picker render, every brokered vendor
 * turn — need none of that: ai-local-harness and its imports
 * (ai-router-selection → ai-evidence, ai-decision-maker) are pure data and
 * functions. apps/clikcode/scripts/build.mjs bundles this entry to
 * dist/harness-catalog.cjs and fails the build if an AI SDK ever leaks in.
 *
 * Every catalog export of ai-router-runtime.ts is exported here under the same
 * name, so this is a drop-in for the catalog members of `AiRouterRuntime` (see
 * HarnessCatalogRuntime below).
 */
import type { AiRouterRuntime } from './commands/types.js';

// `export *`, not a name list: ai-router-runtime.ts re-exports a growing subset
// of this module, and a wildcard is a superset of any such list by
// construction, so the two entries cannot drift apart. It also matters that ALL
// catalog calls go through one bundle: registerCustomHarnesses() keeps module
// state, and a second copy inside ai-router-runtime.cjs would not see it.
export * from '@clikcode/router/ai-local-harness';

/** What dist/harness-catalog.cjs provides: everything except model streaming. */
export type HarnessCatalogRuntime = Omit<AiRouterRuntime, 'streamAiChatTurn'>;

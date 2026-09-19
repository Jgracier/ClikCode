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
 * Every export here is also exported, under the same name, by
 * ai-router-runtime.ts, so this is a drop-in for the catalog members of
 * `AiRouterRuntime` (see HarnessCatalogRuntime below).
 */
import type { AiRouterRuntime } from './commands/types.js';

export {
  AI_LOCAL_HARNESS_ADAPTER_VERSION,
  AI_LOCAL_HARNESSES,
  AI_LOCAL_HARNESS_CAPABILITIES,
  harnessSupportsEffort,
  harnessSupportsImages,
  harnessIntegrationLevel,
  harnessSupportsPermissionMode,
  localHarnessForCommand,
  localHarnessCapabilityManifest,
  localHarnessForProvider,
  nativeHarnessLaunchArgv,
  nativeHarnessTurnArgv,
} from '@clikdeploy/clikrouter/ai-local-harness';

/** What dist/harness-catalog.cjs provides: everything except model streaming. */
export type HarnessCatalogRuntime = Omit<AiRouterRuntime, 'streamAiChatTurn'>;

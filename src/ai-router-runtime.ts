/**
 * Release-only AI runtime. This is bundled separately as CommonJS because a
 * provider SDK may carry optional native modules; the public CLI itself stays
 * normal native ESM and loads this only for local model work.
 */
export { streamAiChatTurn } from '@clikdeploy/clikrouter/ai-provider-models';
export {
  AI_LOCAL_HARNESS_ADAPTER_VERSION,
  AI_LOCAL_HARNESSES,
  harnessSupportsEffort,
  harnessSupportsImages,
  harnessSupportsPermissionMode,
  localHarnessForCommand,
  localHarnessForProvider,
  nativeHarnessLaunchArgv,
  nativeHarnessTurnArgv,
} from '@clikdeploy/clikrouter/ai-local-harness';

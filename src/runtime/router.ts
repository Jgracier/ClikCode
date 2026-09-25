/**
 * Release-only AI runtime. This is bundled separately as CommonJS because a
 * provider SDK may carry optional native modules; the public CLI itself stays
 * normal native ESM and loads this only for local model work.
 */
export { streamAiChatTurn } from '@clikcode/router/ai-provider-models';
export {
  AI_LOCAL_HARNESS_ADAPTER_VERSION,
  AI_LOCAL_HARNESSES,
  AI_LOCAL_HARNESS_CAPABILITIES,
  HOME_REDIRECT_ENV_DEFAULTS,
  allLocalHarnesses,
  customAcpHarness,
  guardedPromptArgv,
  harnessAcpLaunch,
  harnessLoginArgvForModel,
  harnessReplyError,
  harnessCanRunTurns,
  harnessTierRank,
  harnessTurnTransport,
  maxPromptArgvBytes,
  promptExceedsArgvLimit,
  registerCustomHarnesses,
  harnessSupportsEffort,
  harnessSupportsImages,
  harnessIntegrationLevel,
  harnessSupportsPermissionMode,
  localHarnessForCommand,
  localHarnessCapabilityManifest,
  localHarnessForProvider,
  nativeHarnessLaunchArgv,
  nativeHarnessTurnArgv,
} from '@clikcode/router/ai-local-harness';

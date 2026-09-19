/** Lazy bridge to the separately bundled router runtime. Vendor process
 * parsing deliberately lives elsewhere; this module only exposes catalog and
 * request-building capabilities. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type {
  AiHarnessCapabilityManifest, AiHarnessIntegrationLevel, AiHarnessPermissionMode, AiLocalHarnessDefinition, AiRouterRuntime,
} from './types.js';

const require = createRequire(import.meta.url);
let routerRuntime: AiRouterRuntime | undefined;

export function localRouter(): AiRouterRuntime {
  if (!routerRuntime) {
    try {
      routerRuntime = require('../ai-router-runtime.cjs') as AiRouterRuntime;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
      routerRuntime = require(fileURLToPath(new URL('./ai-router-runtime.cjs', import.meta.url))) as AiRouterRuntime;
    }
  }
  return routerRuntime;
}

export const localHarnessForCommand = (command: string): AiLocalHarnessDefinition | undefined => localRouter().localHarnessForCommand(command);
export const localHarnessForProvider = (provider: string): AiLocalHarnessDefinition | undefined => localRouter().localHarnessForProvider(provider);
export const localHarnessCapabilityManifest = (harness: AiLocalHarnessDefinition): AiHarnessCapabilityManifest => localRouter().localHarnessCapabilityManifest(harness);
export const harnessSupportsEffort = (harness: AiLocalHarnessDefinition): boolean => localRouter().harnessSupportsEffort(harness);
export const harnessSupportsPermissionMode = (harness: AiLocalHarnessDefinition, mode: AiHarnessPermissionMode): boolean => localRouter().harnessSupportsPermissionMode(harness, mode);
export const harnessSupportsImages = (harness: AiLocalHarnessDefinition): boolean => localRouter().harnessSupportsImages(harness);
export const harnessIntegrationLevel = (harness: AiLocalHarnessDefinition): AiHarnessIntegrationLevel => {
  if (harness.integration) return harness.integration;
  // Unit consumers intentionally load this module without the separately
  // bundled router runtime. The structural fallback is also the safe answer
  // for externally supplied definitions; production catalog entries still
  // use the router's canonical classifier.
  try { return localRouter().harnessIntegrationLevel(harness); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    if (harness.surface === 'editor-extension') return 'editor-only';
    if (harness.command === 'codex') return 'native';
    if (['cursor', 'cline', 'opencode', 'copilot', 'hermes', 'droid'].includes(harness.command)) return 'structured';
    return harness.turn?.output === 'text' ? 'compatibility' : 'structured';
  }
};
export const streamLocalAiTurn = (input: Record<string, unknown>): Promise<any> => localRouter().streamAiChatTurn(input);

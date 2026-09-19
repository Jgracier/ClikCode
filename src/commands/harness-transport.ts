import { acpArgvForHarness } from './acp-client.js';
import type { AiLocalHarnessDefinition } from './types.js';

export type HarnessTurnTransport = 'codex-app-server' | 'acp' | 'structured-cli' | 'text-cli';

export interface HarnessTurnTransportOptions {
  /** The caller forwards `images` to runAcpTurn and honours its
   * `acpSafeToFallback` error. Image support is only known after the agent's
   * initialize response (`promptCapabilities.image`), so ACP is attempted and
   * an agent without it fails before the prompt, landing on the CLI fallback.
   * Without this opt-in an image turn keeps using the CLI adapter, because a
   * caller that does not pass the images along would silently drop them. */
  acpImages?: boolean;
}

/** One transport decision for every harness. Provider definitions remain
 * declarative; orchestration no longer grows another command-name branch each
 * time a harness adopts ACP or another shared protocol. */
export function harnessTurnTransport(
  harness: AiLocalHarnessDefinition, hasImages = false, options: HarnessTurnTransportOptions = {},
): HarnessTurnTransport {
  if (harness.command === 'codex') return 'codex-app-server';
  if ((!hasImages || options.acpImages === true) && acpArgvForHarness(harness.command)) return 'acp';
  return harness.turn?.output === 'text' ? 'text-cli' : 'structured-cli';
}

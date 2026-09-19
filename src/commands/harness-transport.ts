import { harnessPreferredTransport } from './harness-runtime.js';
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
  /** Opt an `acp.experimental` declaration into ACP. Off by default: an
   * unverified ACP mode must not displace a working structured CLI. */
  allowExperimentalAcp?: boolean;
}

/** One transport decision for every harness, read from the catalog
 * declaration (`transport` + `acp`), never from the harness name. Adopting
 * ACP is a catalog edit, not another branch here. */
export function harnessTurnTransport(
  harness: AiLocalHarnessDefinition, hasImages = false, options: HarnessTurnTransportOptions = {},
): HarnessTurnTransport {
  return harnessPreferredTransport(harness, {
    hasImages: hasImages && options.acpImages !== true,
    ...(options.allowExperimentalAcp === true ? { allowExperimentalAcp: true } : {}),
  });
}

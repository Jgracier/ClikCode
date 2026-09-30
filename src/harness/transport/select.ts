import { harnessPreferredTransport } from '../../runtime/lazy-bridge.js';
import type { AiLocalHarnessDefinition } from '../definition.js';
import type { HarnessSession } from '../../session/model.js';

export type HarnessTurnTransport = 'codex-app-server' | 'acp' | 'structured-cli' | 'text-cli';

interface HarnessTurnTransportOptions {
  /** The caller forwards `images` to runAcpTurn and honours its
   * `acpUnsupportedImages` error. Image support is only known after the agent's
   * initialize response (`promptCapabilities.image`), so ACP is attempted and
   * an agent without it fails before the prompt, landing on the CLI fallback.
   * Without this opt-in an image turn keeps using the CLI adapter, because a
   * caller that does not pass the images along would silently drop them. */
  acpImages?: boolean;
}

/** One transport decision for every harness, read from the catalog
 * declaration (`transport` + `acp`), never from the harness name. Adopting
 * ACP is a catalog edit, not another branch here. */
export function harnessTurnTransport(
  harness: AiLocalHarnessDefinition, hasImages = false, options: HarnessTurnTransportOptions = {},
): HarnessTurnTransport {
  return harnessPreferredTransport(harness, {
    hasImages: hasImages && options.acpImages !== true,
  });
}

/** A vendor thread stays on the transport that created it. Older chats for
 * newly promoted ACP harnesses have no marker and belong to their CLI. */
export function sessionTurnTransport(
  harness: AiLocalHarnessDefinition,
  session: Pick<HarnessSession, 'nativeSessionId' | 'nativeSessionPreallocated' | 'nativeTransport'>,
  hasImages = false,
  options: HarnessTurnTransportOptions = {},
): HarnessTurnTransport {
  if (session.nativeSessionId && !session.nativeSessionPreallocated) {
    if (session.nativeTransport === 'acp' && harness.acp) return 'acp';
    if ((session.nativeTransport === 'structured-cli' || session.nativeTransport === 'text-cli') && harness.turn) return session.nativeTransport;
    if (!session.nativeTransport && harness.acp?.legacyCliSessions && harness.turn) {
      return harness.turn.output === 'text' ? 'text-cli' : 'structured-cli';
    }
  }
  return harnessTurnTransport(harness, hasImages, options);
}

import { harnessPreferredTransport } from '../../runtime/lazy-bridge.js';
import type { AiLocalHarnessDefinition } from '../definition.js';
import type { HarnessSession } from '../../session/model.js';

export type HarnessTurnTransport = 'codex-app-server' | 'acp' | 'structured-cli' | 'text-cli';

/** One transport decision for every harness, read from the catalog
 * declaration (`transport` + `acp`), never from the harness name. Adopting
 * ACP is a catalog edit, not another branch here. Image turns take the same
 * transport: image support is only known after the agent's initialize
 * response (`promptCapabilities.image`), so ACP is attempted and an agent
 * without it fails before the prompt with `acpUnsupportedImages`, landing on
 * the CLI fallback. */
export function harnessTurnTransport(harness: AiLocalHarnessDefinition): HarnessTurnTransport {
  return harnessPreferredTransport(harness);
}

/** A vendor thread stays on the transport that created it. Older chats for
 * newly promoted ACP harnesses have no marker and belong to their CLI. */
export function sessionTurnTransport(
  harness: AiLocalHarnessDefinition,
  session: Pick<HarnessSession, 'nativeSessionId' | 'nativeSessionPreallocated' | 'nativeTransport'>,
): HarnessTurnTransport {
  if (session.nativeSessionId && !session.nativeSessionPreallocated) {
    if (session.nativeTransport === 'acp' && harness.acp) return 'acp';
    if ((session.nativeTransport === 'structured-cli' || session.nativeTransport === 'text-cli') && harness.turn) return session.nativeTransport;
    if (!session.nativeTransport && harness.acp?.legacyCliSessions && harness.turn) {
      return harness.turn.output === 'text' ? 'text-cli' : 'structured-cli';
    }
  }
  return harnessTurnTransport(harness);
}

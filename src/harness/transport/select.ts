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

/** A vendor thread stays on the transport that created it (its
 * `nativeTransport` marker, stamped when the thread is made). A harness
 * whose ACP and CLI share one session store (`sharedSessions`) has no such
 * tie: its threads always take the preferred transport. Pinning them once
 * left a Grok chat on the one-shot CLI for good after a single fallback turn
 * -- no live process, so nothing it started outlived a turn. */
export function sessionTurnTransport(
  harness: AiLocalHarnessDefinition,
  session: Pick<HarnessSession, 'nativeSessionId' | 'nativeSessionPreallocated' | 'nativeTransport'>,
): HarnessTurnTransport {
  if (session.nativeSessionId && !session.nativeSessionPreallocated && !harness.acp?.sharedSessions) {
    if (session.nativeTransport === 'acp' && harness.acp) return 'acp';
    if ((session.nativeTransport === 'structured-cli' || session.nativeTransport === 'text-cli') && harness.turn) return session.nativeTransport;
  }
  return harnessTurnTransport(harness);
}

/** The marker for a thread the vendor's one-shot CLI started -- a chat
 * adopted from the vendor's own list or attached by id, or a turn ACP could
 * not take: that CLI, unless ACP shares its store (or there is no ACP to
 * tell it from), when the thread is not pinned at all. */
export function cliThreadTransport(harness: AiLocalHarnessDefinition): 'structured-cli' | 'text-cli' | undefined {
  if (!harness.acp || harness.acp.sharedSessions || !harness.turn) return undefined;
  return harness.turn.output === 'text' ? 'text-cli' : 'structured-cli';
}

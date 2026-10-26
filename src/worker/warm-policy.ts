/** Warm an opened vendor chat only when its transport can keep the process. */
import type { HarnessSession } from '../session/model.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { sessionTurnTransport } from '../harness/transport/select.js';

export function shouldWarmVendorChat(session: HarnessSession): boolean {
  if (session.route !== 'local' || !session.nativeHarness || !session.accountId
    || (!session.nativeSessionId && !session.messages?.length)) return false;
  const harness = localHarnessForCommand(session.nativeHarness);
  if (!harness) return false;
  const transport = sessionTurnTransport(harness, session);
  return transport === 'acp' || transport === 'codex-app-server';
}

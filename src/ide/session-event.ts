/** The `session` event, with the model named the way the terminal names it
 * so the editor never re-derives a label from an id. */
import { sessionModelLabel } from '../harness/output.js';
import type { HarnessSession } from '../session/model.js';
import { GATEWAY_LABEL } from '../session/route.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import type { IdeEvent } from './protocol.js';

/** What `choose provider` calls the provider a session runs on, and its
 * name as the provider list shows it (IdeProvider `id` and `name`). */
export function sessionProvider(session: HarnessSession): { id?: string; name?: string } {
  if (session.route === 'gateway') return { id: 'gateway', name: GATEWAY_LABEL };
  // A model on this computer is hosted AI under the Gateway: the same provider (hosted-models/).
  if (session.route === 'clikcode-local') return { id: 'gateway', name: GATEWAY_LABEL };
  if (!session.nativeHarness) return {};
  const name = localHarnessForCommand(session.nativeHarness)?.displayName;
  return { id: session.nativeHarness, ...(name ? { name } : {}) };
}

export function sessionEvent(session: HarnessSession, account?: string): Extract<IdeEvent, { type: 'session' }> {
  // Automatic is `auto` and reads "Automatic": the model the Gateway routed to is not shown.
  const automatic = session.route === 'gateway' && !session.model && !session.gatewayAgentId;
  const model = automatic ? 'auto' : session.reported?.model ?? session.model ?? undefined;
  const label = model ? sessionModelLabel(session, model) : undefined;
  const provider = sessionProvider(session);
  return {
    type: 'session', session, ...(account ? { account } : {}), ...(model && label ? { modelLabel: { model, label } } : {}),
    ...(provider.id ? { providerId: provider.id } : {}), ...(provider.name ? { providerName: provider.name } : {}),
  };
}

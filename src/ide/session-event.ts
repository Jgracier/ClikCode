/** The `session` event, with the model named the way the terminal names it
 * so the editor never re-derives a label from an id. */
import { sessionModelLabel } from '../harness/output.js';
import type { HarnessSession } from '../session/model.js';
import type { IdeEvent } from './protocol.js';

export function sessionEvent(session: HarnessSession, account?: string): Extract<IdeEvent, { type: 'session' }> {
  // Automatic is `auto` and reads "Automatic": the model the Gateway routed to is not shown.
  const automatic = session.route === 'gateway' && !session.model && !session.gatewayAgentId;
  const model = automatic ? 'auto' : session.reported?.model ?? session.model ?? undefined;
  const label = model ? sessionModelLabel(session, model) : undefined;
  return { type: 'session', session, ...(account ? { account } : {}), ...(model && label ? { modelLabel: { model, label } } : {}) };
}

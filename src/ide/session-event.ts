/** The `session` event, with the model named the way the terminal names it
 * so the editor never re-derives a label from an id. */
import { sessionModelLabel } from '../harness/output.js';
import type { HarnessSession } from '../session/model.js';
import type { IdeEvent } from './protocol.js';

export function sessionEvent(session: HarnessSession, account?: string): Extract<IdeEvent, { type: 'session' }> {
  const model = session.reported?.model ?? session.model ?? undefined;
  const label = model ? sessionModelLabel(session, model) : undefined;
  return { type: 'session', session, ...(account ? { account } : {}), ...(model && label ? { modelLabel: { model, label } } : {}) };
}

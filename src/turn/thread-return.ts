/** Context added while a conversation was using another harness. The old
 * vendor thread already holds everything before `through`; replaying it would
 * duplicate history and spend its context window again. */
import type { HarnessSession, TranscriptMessage } from '../session/model.js';
import { canonicalRecord } from '../session/canonical.js';
import type { RecordReach } from '../session/full-record.js';
import { transferPrompt } from './transfer.js';

export function returnPrompt(
  session: HarnessSession, messages: readonly TranscriptMessage[], through: number,
  request: string, maxBytes: number, recordReach?: RecordReach,
): string {
  const missed = messages.slice(through);
  if (!missed.length) return request;
  const delta = canonicalRecord({ ...session, messages: [...missed], pendingTurn: undefined, summary: undefined });
  return transferPrompt(delta, request, { maxBytes, ...(recordReach ? { recordReach } : {}) });
}

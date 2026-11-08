/** What the stored conversation is checked against before a turn continues it.
 *
 * ClikCode's record of a conversation (its log and index row) is the only copy
 * of turns other vendors answered, so a record that fell behind is never
 * something to carry on from: a vendor thread that is consistent with the old
 * record would resume as if nothing were missing. These checks use evidence the
 * record does not hold for itself -- the count the index row last wrote, and
 * what the vendor's own thread says it was last asked -- and decide only on
 * positive evidence; where the evidence cannot be read or aligned they say
 * nothing (`unknown`). */

import type { HarnessSession, TranscriptMessage } from './model.js';
import { stripResourceNotes } from '../turn/resource-note-text.js';

/** The stored conversation is behind what independent evidence shows it had. */
export class StoreBehindError extends Error {
  constructor(readonly sessionId: string, detail: string) {
    super(`The stored history of conversation ${sessionId} is behind: ${detail}. ClikCode will not continue from it, and rebuilds nothing from older copies. `
      + `Run \`clikcode sessions audit\` to see what survives, then \`clikcode sessions repair ${sessionId}\`.`);
    this.name = 'StoreBehindError';
  }
}

/** The log holds fewer messages than the index row says it held when last written. */
export function checkStoreAgainstIndex(session: Pick<HarnessSession, 'id' | 'messages' | 'listMessageCount'>): void {
  const counted = session.listMessageCount;
  const have = session.messages?.length;
  if (counted === undefined || have === undefined || have >= counted) return;
  throw new StoreBehindError(session.id, `the index last recorded ${counted} messages and the log holds ${have}`);
}

/** Text aligned for comparing a request as the user wrote it with the same request as a thread
 * received it (resource notes in front, whitespace, attachments after). */
export function requestKey(text: string): string {
  return stripResourceNotes(text).replace(/\s+/g, ' ').trim();
}

/** Text the harness or the app put in front of a model that the user never typed: command echoes, system
 * reminders, background-agent notices, interruption markers, handover notes. It is no part of the
 * conversation, so it is never evidence of one. */
export function isInjectedRequest(text: string): boolean {
  return /^\s*(<(command-|local-command|system-reminder|task-notification|subagent_notification|clikcode_)|\[(Request interrupted|ClikCode[:\]]))/.test(text);
}

/** A request must be this long before it is evidence: "yes" aligns with anything. */
const MIN_ALIGNED = 24;
const HEAD = 80;

export type ThreadCoverage =
  /** The thread's newest request is the conversation's newest. */
  | { kind: 'current' }
  /** The conversation has `missed` user turns after the thread's newest request. */
  | { kind: 'behind'; missed: number }
  /** The thread was asked something the conversation does not hold, later than the conversation was last updated. */
  | { kind: 'ahead'; request: string }
  | { kind: 'unknown' };

/** Where a vendor thread's newest request stands in the conversation. `request.at`: when the thread
 * received it. */
export function threadCoverage(
  request: { text: string; at?: string } | undefined, messages: readonly TranscriptMessage[], updatedAt: string | undefined,
): ThreadCoverage {
  if (!request) return { kind: 'unknown' };
  if (isInjectedRequest(request.text)) return { kind: 'unknown' };
  const asked = requestKey(request.text);
  if (asked.length < MIN_ALIGNED) return { kind: 'unknown' };
  const users: string[] = [];
  for (const message of messages) if (message.role === 'user') users.push(requestKey(message.content));
  for (let index = users.length - 1; index >= 0; index -= 1) {
    const mine = users[index]!;
    if (mine.length < MIN_ALIGNED) continue;
    if (asked.includes(mine.slice(0, HEAD)) || mine.includes(asked.slice(0, HEAD))) {
      const missed = users.length - 1 - index;
      return missed ? { kind: 'behind', missed } : { kind: 'current' };
    }
  }
  // Nothing aligns. That alone is not proof (a request ClikCode stored differently from what it sent):
  // it is when the thread was asked it after the conversation was last written.
  const at = Date.parse(request.at ?? '');
  const written = Date.parse(updatedAt ?? '');
  if (Number.isFinite(at) && Number.isFinite(written) && at > written + 60_000) return { kind: 'ahead', request: asked.slice(0, 200) };
  return { kind: 'unknown' };
}

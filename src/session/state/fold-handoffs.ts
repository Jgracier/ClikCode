/** Conversations from before a provider switch happened in place.
 *
 * Every switch used to make a child session -- a "handoff" branch -- holding
 * a copy of the whole history and running on the new provider. A
 * conversation switched thirty times was thirty-one sessions. Each one is
 * folded into the newest branch that carries all of it: that branch is the
 * conversation from now on, and the older ones are kept, not deleted (their
 * vendor threads stay valid), only no longer listed (`foldedInto`).
 *
 * A branch is folded only where nothing would be hidden: another branch made
 * from it holds its entire history, and nothing is queued or parked on it. A
 * branch that went on after the switch, or two that went separate ways, stay.
 * Forks (/fork, /compact) were never handoffs and stay branches.
 *
 * Who answered each turn was read from the chain of branches; it is stamped
 * on the messages now (the stamp a turn gets when it is committed), so
 * nothing needs the chain again. Idempotent: a branch carries the `handoff`
 * marker until it has been looked at here, and only then is it dropped -- so
 * this runs again only for a branch an older build made since. */

import type { HarnessSession, MessageOrigin, TranscriptMessage } from '../model.js';
import { messageOrigin, sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { normalizeImportedTranscript } from '../../turn/failover-prompt.js';

/** A session as builds before in-place switching stored it. */
type Stored = HarnessSession & { handoff?: { fromSessionId: string } };

export interface FoldReport { folded: number; stamped: number }

/** Whether any session still carries the marker of a branch not looked at. */
export function hasUnfoldedHandoffs(sessions: readonly HarnessSession[]): boolean {
  return sessions.some((session) => (session as Stored).handoff);
}

const sameTurn = (left: TranscriptMessage, right: TranscriptMessage | undefined): boolean =>
  !!right && left.role === right.role && left.content === right.content;

/** `child` holds all of `parent`'s history, in order, from the start. */
function covers(child: HarnessSession, parent: HarnessSession): boolean {
  const theirs = sessionTranscriptMessages(parent);
  const ours = sessionTranscriptMessages(child);
  return theirs.every((message, index) => sameTurn(message, ours[index]));
}

/** Who wrote each message: a message shared with an ancestor (a common
 * prefix) is that ancestor's or older; what follows the longest prefix shared
 * with the parent is the session's own. A stamp, where there is one, wins.
 * Compared as every reader sees a transcript (normalizeImportedTranscript
 * drops ClikCode's own old continuation prompts); a message no reader sees
 * keeps the session's own. */
function chainOrigins(session: HarnessSession, byId: ReadonlyMap<string, HarnessSession>): MessageOrigin[] {
  const messages = session.messages ?? [];
  const origins = messages.map(() => messageOrigin(session));
  const read = messages.flatMap((message, index) => normalizeImportedTranscript([message]).map((seen) => ({ seen, index })));
  let owned = read.length;
  const seen = new Set([session.id]);
  for (let id = session.parentSessionId; id && owned && !seen.has(id);) {
    const ancestor = byId.get(id);
    if (!ancestor) break;
    seen.add(id);
    const theirs = sessionTranscriptMessages(ancestor);
    let shared = 0;
    while (shared < owned && sameTurn(read[shared]!.seen, theirs[shared])) shared += 1;
    for (const { index } of read.slice(0, shared)) origins[index] = messageOrigin(ancestor);
    owned = shared;
    id = ancestor.parentSessionId;
  }
  return messages.map((message, index) => message.origin ?? origins[index]!);
}

/** Folds `sessions` (every transcript loaded) in place. */
export function foldHandoffBranches(sessions: readonly HarnessSession[]): FoldReport {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const report: FoldReport = { folded: 0, stamped: 0 };
  // Every answer in a chain of branches, stamped before anything changes:
  // the chain is what says who wrote it.
  const inChain = new Set(sessions.flatMap((session) => (session.parentSessionId ? [session.id, session.parentSessionId] : [])));
  const stamps = new Map(sessions.filter((session) => inChain.has(session.id)).map((session) => [session, chainOrigins(session, byId)]));
  for (const [session, origins] of stamps) {
    if (!session.messages?.some((message) => !message.origin)) continue;
    session.messages = session.messages.map((message, index) => (message.origin ? message : { ...message, origin: origins[index]! }));
    report.stamped += 1;
  }
  const newestFirst = (sessions as Stored[]).filter((session) => session.handoff)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const branch of newestFirst) {
    const parent = byId.get(branch.handoff!.fromSessionId);
    const busy = parent?.resumeAt || parent?.queuedTurns?.some((item) => item.kind !== 'notification');
    if (parent && !parent.foldedInto && !busy && covers(branch, parent)) {
      parent.foldedInto = branch.id;
      report.folded += 1;
    }
  }
  for (const branch of newestFirst) delete branch.handoff;
  return report;
}

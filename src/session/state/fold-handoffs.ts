/** Conversations from before a provider switch happened in place, read as
 * one chat history.
 *
 * Every switch used to make a child session -- a branch -- holding a copy of
 * the whole history and running on the new provider. A conversation switched
 * thirty times was thirty-one sessions, and some of them went on on their own:
 * a switch where the user went back to the old provider and switched again
 * later left two branches from the same point, each with turns the other
 * lacks. They are all one conversation. Every branch a switch made is folded
 * into the newest one (the line the conversation went on in): turns of a
 * branch that the newest lacks are merged into it first, where they
 * happened, stamped with who answered them; then the branch is kept, not
 * deleted (its vendor thread stays valid), only no longer listed
 * (`foldedInto`). One listed chat per conversation, plus its forks.
 *
 * Forks (/fork, /compact) are not switches and stay chats of their own: they
 * carry `fork`, and one from before the marker is told by what made it -- the
 * same provider as the chat it came from (a switch is a change of provider by
 * definition), a "(fork)" name, or /compact's summary opening.
 *
 * A branch with queued or parked work, or a turn a live process is still
 * running, is left as it is until that work is done; a turn left in the
 * journal by a process long gone is history like any other and goes along. Nothing is lost: a branch is folded only once everything it
 * holds is in the one it is folded into. Idempotent: a folded branch is never
 * looked at again, and the check that anything is left to do reads only the
 * index (hasLooseBranches), so a store with nothing to fold is not loaded
 * whole on every read. */

import type { HarnessSession, MessageOrigin, TranscriptMessage } from '../model.js';
import { messageOrigin, sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { normalizeImportedTranscript } from '../../turn/failover-prompt.js';

/** The first message of a chat /compact made. */
export const COMPACTED_OPENING = 'Summary of the conversation so far (compacted by ClikCode):';

/** A session as builds before in-place switching stored it. */
type Stored = HarnessSession & { handoff?: { fromSessionId: string } };

export interface FoldReport { folded: number; merged: number; stamped: number; forks: number }

/** Whether `child` was made from `parent` as a fork, by what the index says.
 * Without the marker: /fork's own default name, or the same provider as the
 * chat it came from under a name of its own. A switch is a change of
 * provider; the few branches older builds made on the same provider (another
 * account, two windows resuming one turn) kept the name as it was, but for
 * an adopted chat's "(from <vendor>)". */
function forkByIndex(child: HarnessSession, parent: HarnessSession): boolean {
  if (child.fork || / \(fork\)$/.test(child.name ?? '')) return true;
  const sameProvider = child.route === parent.route && child.nativeHarness === parent.nativeHarness && child.provider === parent.provider;
  return sameProvider && baseName(child) !== baseName(parent);
}

/** A name without the "(from <vendor>)" an adopted chat's carries. */
const baseName = (session: HarnessSession): string => (session.name ?? '').replace(/\s+\(from [^)]+\)$/i, '').trim();

/** The chats each switch-made branch belongs with: sessions joined through
 * parent links that are not forks, keyed by the session the line starts at. */
function lines(sessions: readonly HarnessSession[], fork: (child: HarnessSession, parent: HarnessSession) => boolean): Map<string, HarnessSession[]> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const start = (session: HarnessSession): string => {
    const seen = new Set<string>();
    let at = session;
    for (;;) {
      seen.add(at.id);
      const parent = at.parentSessionId ? byId.get(at.parentSessionId) : undefined;
      if (!parent || seen.has(parent.id) || fork(at, parent) || parent.clerkOf) return at.id;
      at = parent;
    }
  };
  const result = new Map<string, HarnessSession[]>();
  for (const session of sessions) {
    if (session.clerkOf) continue;
    const key = start(session);
    result.set(key, [...result.get(key) ?? [], session]);
  }
  return result;
}

const listed = (session: HarnessSession): boolean => !session.foldedInto && !session.clerkOf;

/** Whether any conversation still has two listed chats from provider
 * switches. Reads only the index. */
export function hasLooseBranches(sessions: readonly HarnessSession[]): boolean {
  if (sessions.some((session) => (session as Stored).handoff)) return true;
  for (const line of lines(sessions, forkByIndex).values()) {
    if (line.filter(listed).length > 1) return true;
  }
  return false;
}

const sameTurn = (left: TranscriptMessage, right: TranscriptMessage | undefined): boolean =>
  !!right && left.role === right.role && left.content === right.content;

/** Each message as every reader sees it (normalizeImportedTranscript drops
 * ClikCode's own old continuation prompts), with where it is stored. */
const seenMessages = (session: HarnessSession): Array<{ seen: TranscriptMessage; index: number }> =>
  (session.messages ?? []).flatMap((message, index) => normalizeImportedTranscript([message]).map((seen) => ({ seen, index })));

function sharedPrefix(left: ReadonlyArray<{ seen: TranscriptMessage }>, right: ReadonlyArray<{ seen: TranscriptMessage }>): number {
  let shared = 0;
  while (shared < left.length && sameTurn(left[shared]!.seen, right[shared]?.seen)) shared += 1;
  return shared;
}

/** Who wrote each message, and the session it was first written in: a
 * message shared with an ancestor (a common prefix) is that ancestor's or
 * older; what follows the longest prefix shared with the parent is the
 * session's own. A stamp, where there is one, wins for who wrote it. A
 * message no reader sees keeps the session's own. */
function chainOwners(session: HarnessSession, byId: ReadonlyMap<string, HarnessSession>): Array<{ origin: MessageOrigin; owner: HarnessSession }> {
  const messages = session.messages ?? [];
  const owners = messages.map(() => ({ origin: messageOrigin(session), owner: session }));
  const read = seenMessages(session);
  let owned = read.length;
  const seen = new Set([session.id]);
  for (let id = session.parentSessionId; id && owned && !seen.has(id);) {
    const ancestor = byId.get(id);
    if (!ancestor) break;
    seen.add(id);
    const shared = sharedPrefix(read.slice(0, owned), seenMessages(ancestor));
    for (const { index } of read.slice(0, shared)) owners[index] = { origin: messageOrigin(ancestor), owner: ancestor };
    owned = shared;
    id = ancestor.parentSessionId;
  }
  return messages.map((message, index) => ({ ...owners[index]!, origin: message.origin ?? owners[index]!.origin }));
}

/** Whether `needle` occurs in `haystack` as one run. */
function contains(haystack: readonly TranscriptMessage[], needle: readonly TranscriptMessage[]): boolean {
  if (!needle.length) return true;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((message, offset) => sameTurn(message, haystack[start + offset]))) return true;
  }
  return false;
}

/** Merges `branch`'s turns that `into` lacks into `into`, where they
 * happened: after the history the two share, before the first of `into`'s
 * later turns that was written in a session made after the branch was (a
 * message is dated by the session it was first written in, the one thing
 * stored about when it happened). Whole turns: the merge starts at a user
 * message. Returns whether anything was added. */
function mergeInto(into: HarnessSession, branch: HarnessSession, byId: ReadonlyMap<string, HarnessSession>): boolean {
  const theirs = sessionTranscriptMessages(branch).map((seen) => ({ seen }));
  const ours = seenMessages(into);
  let from = sharedPrefix(theirs, ours);
  while (from > 0 && theirs[from]?.seen.role === 'assistant') from -= 1;
  const own = theirs.slice(from).map(({ seen }) => seen);
  if (!own.length || contains(ours.map(({ seen }) => seen), own)) return false;
  const messages = into.messages ?? [];
  const owners = chainOwners(into, byId);
  const start = ours[from]?.index ?? messages.length;
  const later = messages.findIndex((message, index) => index >= start && message.role === 'user' && owners[index]!.owner.createdAt > branch.createdAt);
  const at = later >= 0 ? later : messages.length;
  const origin = messageOrigin(branch);
  into.messages = [...messages.slice(0, at), ...own.map((message) => ({ ...message, origin: message.origin ?? origin })), ...messages.slice(at)];
  return true;
}

/** Busy: something is still to happen on it, so it is not folded yet. */
const busy = (session: HarnessSession, running: (id: string) => boolean): boolean =>
  !!(session.resumeAt || (session.pendingTurn && running(session.id)) || session.queuedTurns?.some((item) => item.kind !== 'notification'));

/** The chat a line goes on in: the newest, then the one holding the most. */
const newest = (left: HarnessSession, right: HarnessSession): number =>
  right.updatedAt.localeCompare(left.updatedAt)
  || (right.messages?.length ?? 0) - (left.messages?.length ?? 0)
  || right.createdAt.localeCompare(left.createdAt);

/** Folds `sessions` (every transcript loaded) in place. `running`: whether
 * a process is running the session's turn now (liveWorkerSessions). */
export function foldHandoffBranches(sessions: readonly HarnessSession[], running: (id: string) => boolean = () => false): FoldReport {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const report: FoldReport = { folded: 0, merged: 0, stamped: 0, forks: 0 };
  // A fork from before the marker, told by what made it, gets the marker, so
  // the index alone says it from now on.
  const fork = (child: HarnessSession, parent: HarnessSession): boolean =>
    forkByIndex(child, parent) || child.messages?.[0]?.content === COMPACTED_OPENING;
  for (const session of sessions) {
    const parent = session.parentSessionId ? byId.get(session.parentSessionId) : undefined;
    if (parent && !session.fork && fork(session, parent)) { session.fork = true; report.forks += 1; }
  }
  // Every answer in a chain of branches, stamped before anything changes:
  // the chain is what says who wrote it.
  const inChain = new Set(sessions.flatMap((session) => (session.parentSessionId ? [session.id, session.parentSessionId] : [])));
  const stamps = new Map(sessions.filter((session) => inChain.has(session.id)).map((session) => [session, chainOwners(session, byId)]));
  for (const [session, owners] of stamps) {
    if (!session.messages?.some((message) => !message.origin)) continue;
    session.messages = session.messages.map((message, index) => (message.origin ? message : { ...message, origin: owners[index]!.origin }));
    report.stamped += 1;
  }
  for (const line of lines(sessions, fork).values()) {
    const open = line.filter(listed).sort(newest);
    const into = open[0];
    if (!into) continue;
    // Oldest first, so each merge lands among what came before it.
    for (const branch of open.slice(1).reverse()) {
      if (busy(branch, running)) continue;
      if (mergeInto(into, branch, byId)) report.merged += 1;
      branch.foldedInto = into.id;
      report.folded += 1;
    }
  }
  for (const session of sessions as Stored[]) delete session.handoff;
  return report;
}

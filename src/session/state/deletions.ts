/** Deleting a conversation is an act, never a conclusion.
 *
 * A write used to conclude that a conversation was deleted when it was in the
 * state a caller had read and absent from the state it wrote back, or when it
 * was in that read and gone from the index on disk. So anything that made an
 * index shorter -- a test run that wrote a fresh one, a restored snapshot, a
 * damaged file -- was read by every other running ClikCode as "someone deleted
 * these", and each of them deleted the transcripts, checkpoints and tool output
 * of every chat it knew. A month of conversations went that way in one minute.
 *
 * Now the files of a conversation are removed only for one a caller deleted with
 * deleteConversations, and other processes learn of it from a tombstone in the
 * index (`deletedSessions`). A row that is simply missing from the index is not a
 * deletion: a process that holds it puts it back (merge.ts mergeSessionRows). */

import type { HarnessSession, HarnessState } from '../model.js';
import { hidden } from '../store/data.js';
import { loadIndex } from './index-file.js';

/** Conversations deleted through this state object since it was last written. */
export const DELETIONS = Symbol('clikcode.deletions');
type Deleting = HarnessState & { [DELETIONS]?: Set<string> };

/** Deletes conversations from `state`: gone from its list now, and their files removed by the
 * next writeState that stores it. The only way a conversation is deleted. */
export function deleteConversations(state: HarnessState, ids: Iterable<string>): void {
  const doomed = new Set(ids);
  if (!doomed.size) return;
  state.sessions = state.sessions.filter((item: HarnessSession) => !doomed.has(item.id));
  const held = (state as Deleting)[DELETIONS] ?? new Set<string>();
  for (const id of doomed) held.add(id);
  hidden(state, DELETIONS, held);
}

/** What `state` has deleted and not yet written. */
export function pendingDeletions(state: HarnessState): ReadonlySet<string> {
  return (state as Deleting)[DELETIONS] ?? new Set();
}

export function clearDeletions(state: HarnessState, written: ReadonlySet<string>): void {
  const held = (state as Deleting)[DELETIONS];
  if (!held) return;
  for (const id of written) held.delete(id);
}

/** Tombstones older than this are dropped: a process that has held a conversation open this long
 * has been told "gone" by its own read of the index long since. */
export const TOMBSTONE_KEEP_MS = 90 * 24 * 60 * 60_000;

/** The tombstones after a write: the index's own, those it adds, minus any for a conversation that
 * is listed again, minus the old. */
export function nextTombstones(
  stored: Readonly<Record<string, string>> | undefined, added: Iterable<string>, listed: ReadonlySet<string>, now = Date.now(),
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [id, at] of Object.entries(stored ?? {})) {
    if (!listed.has(id) && now - (Date.parse(at) || 0) < TOMBSTONE_KEEP_MS) out[id] = at;
  }
  for (const id of added) if (!listed.has(id)) out[id] = new Date(now).toISOString();
  return Object.keys(out).length ? out : undefined;
}

/** Whether the index records `id` as deleted: told from a row that is merely missing. */
export async function conversationWasDeleted(id: string): Promise<boolean> {
  return Boolean((await loadIndex())?.deletedSessions?.[id]);
}

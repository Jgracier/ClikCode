/** What a window runs next from a conversation's queue -- the one rule the terminal (its loop) and
 * the editor (its bridge) both follow, so the two cannot drift apart.
 *
 *  - a slash command typed during a turn: run it, as the command it is;
 *  - a message: send it, as that queued turn -- unless the last turn was stopped, when queued
 *    messages wait for the user (sending them would look as if the Stop had failed);
 *  - a notification (a background shell finished): nothing -- the worker runs those itself;
 *  - the same entry that was just run and is still at the head: nothing -- it failed and the worker
 *    refuses it, so running it again would only fail again. */
import type { HarnessSession } from './model.js';

type Queued = NonNullable<HarnessSession['queuedTurns']>[number];

export type QueuedNext = { kind: 'command' | 'message'; entry: Queued } | undefined;

export function queuedNext(session: Pick<HarnessSession, 'queuedTurns'>, options: { stopped?: boolean; justRan?: string } = {}): QueuedNext {
  const entry = session.queuedTurns?.[0];
  if (!entry || entry.kind === 'notification' || entry.id === options.justRan) return undefined;
  if (entry.kind === 'command') return { kind: 'command', entry };
  return options.stopped ? undefined : { kind: 'message', entry };
}

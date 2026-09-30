/** Conversations that have not been used yet.
 *
 * A new chat has to exist while it is open — slash commands and the turn
 * loop address it by id — but it is not a conversation until something
 * happens in it. Until then it lives in this process only. Nothing is
 * written, so leaving it is just forgetting it. There is no file to delete.
 *
 * Keyed by ClikCode's home directory: two tests, or two homes, do not share
 * a draft. */

import { cloneData } from './store/data.js';
import type { HarnessSession } from './model.js';
import { isBlankConversation } from './options.js';

const byHome = new Map<string, Map<string, HarnessSession>>();
/** Written even while still blank, because another process (the turn's
 * worker) has to be able to read the record. Cleared as soon as that write
 * returns. */
const forced = new Set<string>();

function homeKey(): string {
  return process.env.CLIKCODE_HOME?.trim() || 'default';
}

function overlay(): Map<string, HarnessSession> {
  const key = homeKey();
  let drafts = byHome.get(key);
  if (!drafts) byHome.set(key, drafts = new Map());
  return drafts;
}

export function ephemeralSessions(): HarnessSession[] {
  return [...overlay().values()].map((session) => cloneData(session));
}

/** Remember a draft, or forget it once it is a real conversation or has been
 * written. The stored copy is a clone: later edits to the caller's object
 * do not change what the next read will see until the next write. */
export function holdEphemeral(session: HarnessSession): void {
  if (!isBlankConversation(session) || forced.has(session.id)) {
    overlay().delete(session.id);
    return;
  }
  overlay().set(session.id, cloneData(session));
}

export function dropEphemeral(id: string): void {
  overlay().delete(id);
}

export function forceStoreSession(id: string): void {
  forced.add(id);
}

export function unforceStoreSession(id: string): void {
  forced.delete(id);
}

export function sessionForceStored(id: string): boolean {
  return forced.has(id);
}

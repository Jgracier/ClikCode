/** Private resource notices for the model. When steering is unavailable, a
 * notice waits on disk for this conversation's next turn, including after a
 * worker restart. It is never stored as the user's message. */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeRecordFileName, stateDirectory } from '../session/store/paths.js';

import { wrapResourceNote } from './resource-note-text.js';
export { stripResourceNotes, wrapResourceNote } from './resource-note-text.js';

function pathFor(sessionId: string): string { return join(stateDirectory(), 'resource-notes', `${safeRecordFileName(sessionId)}.json`); }
function readNotes(sessionId: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(pathFor(sessionId), 'utf8'));
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}
/** A warning is a current measurement, not a history of every crossing.
 * Keep the latest pending reading of each kind; actual stop notices remain
 * separate because each tells the agent which command ended. */
function warningKey(note: string): string | undefined {
  if (note.includes('Disk I/O is stalling the machine')) return note.includes('Your `') ? 'io-owned' : 'io-global';
  if (note.includes('Memory is getting tight:')) return 'memory';
  if (note.includes('Disk is getting tight:') || note.includes('Disk is almost full:')) return 'disk-space';
  return undefined;
}
/** The worker owns the conversation; only it writes a pending notice. */
export function holdResourceNote(sessionId: string, note: string): void {
  const path = pathFor(sessionId);
  mkdirSync(join(stateDirectory(), 'resource-notes'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const key = warningKey(note);
  const pending = readNotes(sessionId).filter((held) => !key || warningKey(held) !== key);
  writeFileSync(tmp, JSON.stringify([...pending, wrapResourceNote(note)]), { mode: 0o600 });
  renameSync(tmp, path);
}
/** Attach queued notices to the next outgoing turn, then consume them. */
export function withResourceNotes(sessionId: string, turnText: string): string {
  const notes = readNotes(sessionId);
  if (!notes.length) return turnText;
  rmSync(pathFor(sessionId), { force: true });
  return `${notes.join('\n')}\n\n${turnText}`;
}

/** The note a chat moved from another machine carries to its first turn here
 * (session/move.ts), wrapped as a resource note -- so a vendor's copy of the
 * turn read back is stripped of it like one -- in front of the turn's text.
 * Kept on the session, not on disk beside it: it goes with the chat, and is
 * cleared when that turn completes (turn-journal.ts), not when it starts. */
export function withMoveNote(session: { moveNote?: string }, turnText: string): string {
  return session.moveNote ? `${wrapResourceNote(session.moveNote)}\n\n${turnText}` : turnText;
}

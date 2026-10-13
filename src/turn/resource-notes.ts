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
/** The worker owns the conversation; only it writes a pending notice. */
export function holdResourceNote(sessionId: string, note: string): void {
  const path = pathFor(sessionId);
  mkdirSync(join(stateDirectory(), 'resource-notes'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...readNotes(sessionId), wrapResourceNote(note)]), { mode: 0o600 });
  renameSync(tmp, path);
}
/** Attach queued notices to the next outgoing turn, then consume them. */
export function withResourceNotes(sessionId: string, turnText: string): string {
  const notes = readNotes(sessionId);
  if (!notes.length) return turnText;
  rmSync(pathFor(sessionId), { force: true });
  return `${notes.join('\n')}\n\n${turnText}`;
}

/** Where local ClikCode state lives, and the one rule for turning an id into
 * a filename. Relocatable for tests and portable installs. */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of all local ClikCode state. Relocatable for tests and portable installs. */
export function stateDirectory(): string {
  return process.env.CLIKCODE_HOME?.trim()
    || join(homedir(), '.clikcode');
}

export function sessionsDirectory(): string {
  return join(stateDirectory(), 'sessions');
}

/** Ids are normally UUIDs, but adopted/native ids are arbitrary strings. Anything
 * that is not a plainly safe file name is addressed by digest instead, so an id
 * can never traverse out of the directory. */
export function safeRecordFileName(id: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? id : `h-${createHash('sha256').update(id).digest('hex')}`;
}

export function sessionFilePath(id: string): string {
  return join(sessionsDirectory(), `${safeRecordFileName(id)}.json`);
}

/** The streaming journal builds before the message log wrote beside `<id>.json`
 * (records.ts); read, never written, by this one. Not `.json`: every build
 * lists sessions by that suffix, and an id may itself end in `.turn`, whose
 * transcript is then `<id>.turn.json` -- never this name. */
export function sessionTurnPath(id: string): string {
  return join(sessionsDirectory(), `${safeRecordFileName(id)}.turn`);
}

/** A conversation's message log (chat-log.ts). No other name ends in `.jsonl`,
 * and builds that predate it list sessions by `.json` only, so they never see it. */
export function sessionLogPath(id: string): string {
  return join(sessionsDirectory(), `${safeRecordFileName(id)}.jsonl`);
}

/** The running turn's journal while its answer streams (chat-log.ts). */
export function sessionPendingPath(id: string): string {
  return join(sessionsDirectory(), `${safeRecordFileName(id)}.pending`);
}

/** `<id>.json` as it was when its chat moved to the log: a second name for the
 * same file (a hard link), so the bytes outlive any later rewrite of `<id>.json`. */
export function sessionLegacyBackupPath(id: string): string {
  return join(sessionsDirectory(), `${safeRecordFileName(id)}.json-v1`);
}

/** Per-conversation lock, the same name every build since per-session locks
 * takes for writing `<id>.json`: one lock covers the chat's files in both formats. */
export function sessionLockPath(id: string): string {
  return `${sessionFilePath(id)}.lock`;
}

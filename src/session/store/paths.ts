/** Where local ClikCode state lives, and the one rule for turning an id into
 * a filename. Relocatable for tests and portable installs. */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of all local ClikCode state. Relocatable for tests and portable installs. */
export function stateDirectory(): string {
  const clikCode = process.argv[1]?.includes('clikcode') || process.argv[1]?.includes('index-clikcode');
  return process.env.CLIKCODE_HOME?.trim()
    || process.env.CLIKDEPLOY_AI_HOME?.trim()
    || (clikCode ? join(homedir(), '.clikcode') : join(homedir(), '.clikdeploy', 'ai'));
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

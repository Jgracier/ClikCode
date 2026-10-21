/** What this machine has: its folders and the programs on its PATH, in the words
 * a person reads when one is missing. A chat can be owned by another machine
 * (ClikCode Remote), so "missing" always says WHICH machine it is missing on.
 *
 * Node reports both a missing program and a missing working folder as
 * `spawn <binary> ENOENT`; spawnFailure tells them apart. */
import { statSync } from 'node:fs';
import { hostname } from 'node:os';

/** This machine's short name, as the board shows it. */
export function machineName(): string {
  try { return hostname().split('.')[0] || 'this machine'; } catch { return 'this machine'; }
}

export function folderExists(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function missingFolderMessage(folder: string, machine = machineName()): string {
  return `The folder ${folder} does not exist on ${machine}`;
}

export function notInstalledMessage(name: string, binary: string, machine = machineName()): string {
  return `${name} is not installed on ${machine} (no \`${binary}\` on PATH)`;
}

/** A child that failed to start, said as its cause: the folder it was to run
 * in, or the program itself, is not on this machine. Any other error is
 * returned as it is. The result keeps `code: 'ENOENT'` (and the original as
 * `cause`): it is still not a spent account or a vendor's refusal. */
export function spawnFailure(error: Error, launch: { name: string; binary: string; cwd?: string }): Error {
  const errno = error as NodeJS.ErrnoException;
  if (errno.code !== 'ENOENT' || !(errno.syscall?.startsWith('spawn') ?? /^spawn\b/.test(error.message))) return error;
  const message = launch.cwd && !folderExists(launch.cwd)
    ? missingFolderMessage(launch.cwd)
    : notInstalledMessage(launch.name, launch.binary);
  return Object.assign(new Error(message, { cause: error }), { code: 'ENOENT' });
}

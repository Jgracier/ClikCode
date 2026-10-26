/** Which files the agent may send to a website. Besides a file the user saved in a profile (`*_file`), it may
 * name an absolute path, but only a file inside the workspace or this chat's downloads folder: after symlinks
 * are followed, never a dotfile or a dot folder (~/.ssh, .env, .git), never a private key, never ClikCode's
 * own state, and never something enormous. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readDenyReason, realpathNearest, type PathScope } from '../security.js';
import { downloadsDir } from './downloads.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Names that hold a secret whatever folder they sit in. */
const SECRET_NAME = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|kdbx|keystore|jks)|credentials(?:\.[a-z]+)?|.*secrets?\.(?:json|ya?ml|toml))$/i;

export type UploadScope = Pick<PathScope, 'cwd' | 'stateDir' | 'homeDir'> & { sessionId?: string };

/** True when the upload text is a path rather than the name of a profile file detail. */
export function isUploadPath(text: string | undefined): boolean {
  return !!text && (path.isAbsolute(text) || path.win32.isAbsolute(text) || /^~[\\/]/.test(text) || /[\\/]/.test(text));
}

const inside = (candidate: string, root: string): boolean => { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
const hidden = (relative: string): boolean => relative.split(/[\\/]/).some(part => part.startsWith('.') && part !== '.' && part !== '..');

export async function approvedUploadPath(scope: UploadScope, input: string): Promise<string> {
  const fail = (why: string): never => { throw new Error(`Cannot upload ${path.basename(input) || input}: ${why}. Only a file inside the workspace or this chat's downloads folder (${downloadsDir(scope.stateDir, scope.sessionId)}) can be sent.`); };
  if (input.includes('\0')) return fail('the path is not valid');
  if (!path.isAbsolute(input)) return fail('the path must be absolute');
  const pathScope: PathScope = { cwd: scope.cwd, addDirs: [], stateDir: scope.stateDir, homeDir: scope.homeDir };
  let real: string;
  try { real = await fs.realpath(input); } catch { return fail('there is no such file'); }
  const downloads = realpathNearest(downloadsDir(scope.stateDir, scope.sessionId));
  const workspace = realpathNearest(path.resolve(scope.cwd));
  // The real location, after symlinks, decides: a link inside the workspace that points elsewhere is refused.
  if (!inside(real, downloads)) {
    if (!inside(real, workspace)) return fail('it is outside the workspace and the downloads folder');
    if (hidden(path.relative(workspace, real))) return fail('hidden files and folders (such as .env, .git or .ssh) are never sent');
    const written = path.relative(workspace, path.resolve(input));
    if (!written.startsWith('..') && hidden(written)) return fail('hidden files and folders (such as .env, .git or .ssh) are never sent');
    const denied = readDenyReason({ absolute: path.resolve(input), real, confined: true }, pathScope);
    if (denied) return fail(denied);
  }
  if (SECRET_NAME.test(path.basename(real))) return fail('it looks like a key or credentials file');
  const info = await fs.stat(real);
  if (!info.isFile()) return fail('it is not a file');
  if (info.size > MAX_UPLOAD_BYTES) return fail(`it is ${(info.size / 1024 / 1024).toFixed(0)} MB, over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`);
  return real;
}

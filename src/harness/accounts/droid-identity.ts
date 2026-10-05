/** Factory Droid's signed-in email. Droid keeps its WorkOS login encrypted:
 * `<factory dir>/auth.v2.keyring` (or `auth.v2.file` when the keyring is
 * off) holds `iv:tag:ciphertext`, base64 each, AES-256-GCM, under a 32-byte
 * key kept in the OS keyring (service "Factory CLI", account
 * "auth-encryption-key") or in `auth.v2.key`. The plaintext is
 * {access_token, refresh_token, active_organization_id, whoami}, and the
 * access token is a WorkOS JWT whose `email` claim droid itself requires.
 * Read live 2026-10-05 on droid's own login: the claim is the account's email.
 *
 * Nothing is refreshed or written. On Linux the key is read through the
 * Secret Service (python3 + libsecret's GObject bindings, the only client
 * here that needs no native module) WITHOUT unlocking: a locked keyring names
 * no one rather than popping an unlock prompt. macOS (Keychain access dialog)
 * and Windows (Credential Manager) are not read for the same reason. */

import { execFile } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Decrypt one droid credential file with its key and read the access
 * token's `email` claim. Undefined on any mismatch: wrong key, bad format, no
 * claim. */
export function droidCredentialEmail(encrypted: string, key: Buffer): string | undefined {
  try {
    const parts = encrypted.trim().split(':');
    if (parts.length !== 3 || key.length !== 32) return undefined;
    const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64')) as [Buffer, Buffer, Buffer];
    if (iv.length !== 16 || tag.length !== 16) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const record = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as { access_token?: unknown };
    const payload = typeof record.access_token === 'string' ? record.access_token.split('.')[1] : undefined;
    if (!payload) return undefined;
    const email = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }).email;
    return typeof email === 'string' && EMAIL.test(email.trim()) ? email.trim() : undefined;
  } catch {
    return undefined; // fail-open-ok: an unreadable credential names no one
  }
}

/** Search without SearchFlags.UNLOCK: a locked item comes back without its
 * secret instead of raising an unlock prompt. */
const SECRET_SERVICE_LOOKUP = String.raw`
import sys
import gi
gi.require_version("Secret", "1")
from gi.repository import Secret
schema = Secret.Schema.new("org.freedesktop.Secret.Generic", Secret.SchemaFlags.DONT_MATCH_NAME,
    {"service": Secret.SchemaAttributeType.STRING, "account": Secret.SchemaAttributeType.STRING})
service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION, None)
items = service.search_sync(schema, {"service": "Factory CLI", "account": "auth-encryption-key"}, Secret.SearchFlags.LOAD_SECRETS, None)
for item in items:
    value = item.get_secret()
    if value is not None:
        sys.stdout.write(value.get_text() or "")
        break
`;

function keyringKey(): Promise<Buffer | undefined> {
  if (process.platform !== 'linux') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('python3', ['-c', SECRET_SERVICE_LOOKUP], { timeout: 8_000, windowsHide: true }, (error, stdout) => {
      const key = !error && stdout.trim() ? Buffer.from(stdout.trim(), 'base64') : undefined;
      resolve(key?.length === 32 ? key : undefined);
    });
  });
}

export async function droidAccountEmail(profilePath: string | undefined): Promise<string | undefined> {
  const dir = profilePath ? join(profilePath, '.factory') : process.env.FACTORY_HOME_OVERRIDE?.trim() || join(homedir(), '.factory');
  const read = (name: string): Promise<string | undefined> => readFile(join(dir, name), 'utf8').catch(() => undefined);
  const [keyring, keyFile, file] = await Promise.all([read('auth.v2.keyring'), read('auth.v2.key'), read('auth.v2.file')]);
  if (file && keyFile) {
    const found = droidCredentialEmail(file, Buffer.from(keyFile.trim(), 'base64'));
    if (found) return found;
  }
  if (keyring) {
    const key = await keyringKey();
    if (key) return droidCredentialEmail(keyring, key);
  }
  return undefined;
}

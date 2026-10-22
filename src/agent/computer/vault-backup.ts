/** An encrypted backup of the whole vault (logins, secrets, profiles) that can be restored on another computer.
 *
 * One safe option, kept simple: a passphrase the person types hidden at a terminal. The file is scrypt (N=2^17) into
 * AES-256-GCM; without the passphrase it is noise. No key is printed and nothing is sent anywhere, so there is no
 * recovery key that could land in a model-visible channel. The CLI refuses to run without a terminal for the same reason. */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import fs from 'node:fs/promises';
import { CredentialError, restoreVault, snapshotVault, type VaultSnapshot } from './credential-vault.js';

export const MIN_PASSPHRASE = 12;
const KDF = { N: 1 << 17, r: 8, p: 1 };
type Envelope = { format: 'clikcode-vault-backup'; v: 1; kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }; iv: string; tag: string; data: string };

const derive = (passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(passphrase.normalize('NFKC'), salt, 32, { ...params, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));

export async function writeVaultBackup(stateDir: string, file: string, passphrase: string): Promise<{ logins: number; secrets: number; records: number }> {
  if (passphrase.length < MIN_PASSPHRASE) throw new CredentialError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  const snapshot = await snapshotVault(stateDir);
  const salt = randomBytes(16); const iv = randomBytes(12);
  const key = await derive(passphrase, salt, KDF);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(snapshot), 'utf8'), cipher.final()]);
  key.fill(0);
  const envelope: Envelope = { format: 'clikcode-vault-backup', v: 1, kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') }, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  await fs.writeFile(file, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  return { logins: snapshot.items.length, secrets: snapshot.secrets.length, records: snapshot.records.length };
}

export async function readVaultBackup(stateDir: string, file: string, passphrase: string, options: { overwrite?: boolean } = {}): Promise<{ added: number; skipped: number }> {
  let envelope: Envelope;
  try { envelope = JSON.parse(await fs.readFile(file, 'utf8')) as Envelope; } catch { throw new CredentialError('That file could not be read as a vault backup.'); }
  if (envelope?.format !== 'clikcode-vault-backup' || envelope.v !== 1 || envelope.kdf?.name !== 'scrypt' || !(envelope.kdf.N <= 1 << 20 && envelope.kdf.r <= 16 && envelope.kdf.p <= 4)) throw new CredentialError('That is not a ClikCode vault backup.');
  let snapshot: VaultSnapshot;
  try {
    const key = await derive(passphrase, Buffer.from(envelope.kdf.salt, 'base64'), { N: envelope.kdf.N, r: envelope.kdf.r, p: envelope.kdf.p });
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    snapshot = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')) as VaultSnapshot;
    key.fill(0);
  } catch { throw new CredentialError('Wrong passphrase, or the backup file is damaged.'); }
  return restoreVault(stateDir, snapshot, options);
}

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { lockCredentialVault, readNamedSecret, saveLoginFields, saveNamedSecret, savedLoginFields, savedLoginsForSite } from './credential-vault.js';
import { saveProfile, saveProfileSecret, listProfiles, readProfileSecret } from './profiles.js';
import { readVaultBackup, writeVaultBackup } from './vault-backup.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); } });
const fresh = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), 'clikcode-backup-')); dirs.push(dir); return dir; };
// Built at run time: nothing here is shaped like a real token.
const PASSPHRASE = ['correct', 'horse', 'battery', 'staple'].join(' ');

it('writes an encrypted backup that restores logins, secrets and profiles on another computer', async () => {
  const source = await fresh();
  const target = await fresh();
  const loginPassword = ['Gen', 'Pw', String(Date.now())].join('-');
  const keyValue = ['k', Math.random().toString(36).slice(2), 'value'].join('_');
  await saveLoginFields(source, 'https://shop.example.com/', { username: 'ada@example.com', password: loginPassword });
  await saveNamedSecret(source, 'acme/key', keyValue, { vendor: 'acme', owner: 'ada@example.com' });
  const profile = await saveProfile(source, { label: 'Personal', fields: { given_name: 'Ada' } });
  await saveProfileSecret(source, profile.id, 'password', 'profile-fallback-value');
  const file = join(source, 'backup.json');

  expect(await writeVaultBackup(source, file, PASSPHRASE)).toMatchObject({ logins: 1, secrets: 2 });
  const text = await readFile(file, 'utf8');
  for (const plain of [loginPassword, keyValue, 'ada@example.com', 'acme', 'profile-fallback-value', 'shop.example.com']) expect(text).not.toContain(plain);

  expect(await readVaultBackup(target, file, PASSPHRASE)).toMatchObject({ skipped: 0 });
  const [login] = await savedLoginsForSite(target, 'https://shop.example.com/');
  expect(login!.label).toBe('ada@example.com');
  expect((await savedLoginFields(target, 'https://shop.example.com/', login!.id)).password).toBe(loginPassword);
  expect(await readNamedSecret(target, 'acme/key')).toBe(keyValue);
  const [restored] = await listProfiles(target);
  expect(restored!.fields.given_name).toBe('Ada');
  expect(await readProfileSecret(target, restored!, 'password')).toBe('profile-fallback-value');
});

it('refuses a wrong passphrase, a short one, and a file that is not a backup, and keeps what is already there unless told to replace it', async () => {
  const source = await fresh();
  const file = join(source, 'backup.json');
  await saveNamedSecret(source, 'acme/key', 'first-value-123');
  await expect(writeVaultBackup(source, file, 'short')).rejects.toThrow('at least 12');
  await writeVaultBackup(source, file, PASSPHRASE);
  const target = await fresh();
  await expect(readVaultBackup(target, file, 'not the passphrase at all')).rejects.toThrow('Wrong passphrase');
  await expect(readVaultBackup(target, join(source, 'missing.json'), PASSPHRASE)).rejects.toThrow('could not be read');
  await saveNamedSecret(target, 'acme/key', 'newer-value-456');
  expect(await readVaultBackup(target, file, PASSPHRASE)).toEqual({ added: 0, skipped: 1 });
  expect(await readNamedSecret(target, 'acme/key')).toBe('newer-value-456');
  expect(await readVaultBackup(target, file, PASSPHRASE, { overwrite: true })).toEqual({ added: 1, skipped: 0 });
  expect(await readNamedSecret(target, 'acme/key')).toBe('first-value-123');
});

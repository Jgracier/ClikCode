import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allSavedLogins, loginLabel, lockCredentialVault, removeSavedLogin, sameSite, saveLoginFields, savedLoginFields, savedLoginsForSite, setLoginRejected, siteKey } from './credential-vault.js';

let dir = '';
afterEach(async () => { if (dir) { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); dir = ''; } });

it('generates a local key automatically, stores only encrypted records, and keeps them private to the user', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-vault-'));
  const secret = 'website-only-secret';
  const id = await saveLoginFields(dir, 'https://signin.aws.amazon.com/login', { accountId: 'account-123', username: 'private@example.com', password: secret });
  expect(await savedLoginsForSite(dir, 'https://signin.aws.amazon.com/elsewhere')).toEqual([{ id, label: 'account-123 · private@example.com', rejected: false }]);
  expect(await savedLoginsForSite(dir, 'https://other.example/login')).toEqual([]);
  const vaultDir = join(dir, 'computer', 'vault');
  const items = await readdir(join(vaultDir, 'items'));
  expect(items).toEqual([`${id}.json`]);
  const record = await readFile(join(vaultDir, 'items', items[0]), 'utf8');
  for (const value of [secret, 'private@example.com', 'account-123', 'signin.aws.amazon.com']) expect(record).not.toContain(value);
  expect((await readFile(join(vaultDir, 'vault.key'))).length).toBe(32);
  expect((await stat(join(vaultDir, 'vault.key'))).mode & 0o777).toBe(0o600);
  expect((await stat(join(vaultDir, 'items', items[0]))).mode & 0o777).toBe(0o600);
  lockCredentialVault(dir);
  expect((await savedLoginFields(dir, 'https://signin.aws.amazon.com/login', id)).password).toBe(secret);
  await expect(savedLoginFields(dir, 'https://evil.example/login', id)).rejects.toThrow('does not match');
});

it('lists every account saved for a site by username, in order, and never by password', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-vault-accounts-'));
  await saveLoginFields(dir, 'https://accounts.google.com/', { username: 'two@example.com', password: 'private-password' });
  await saveLoginFields(dir, 'https://accounts.google.com/', { username: 'one@example.com', password: 'other-password' });
  await saveLoginFields(dir, 'https://example.com/', { username: 'elsewhere@example.com', password: 'x' });
  const logins = await savedLoginsForSite(dir, 'https://accounts.google.com/login');
  expect(logins.map(login => login.label)).toEqual(['one@example.com', 'two@example.com']);
  expect(JSON.stringify(logins)).not.toMatch(/password/);
});

it('labels a login by its non-secret fields only', () => {
  expect(loginLabel({ accountId: '123456789012', username: 'admin', password: 'secret' })).toBe('123456789012 · admin');
  expect(loginLabel({ email: 'a@example.com', username: 'a@example.com', password: 'secret' })).toBe('a@example.com');
  expect(loginLabel({ password: 'secret' })).toBe('Saved login');
});

it('treats a cloud sign-in host in any region as the same site, and nothing looser', async () => {
  expect(siteKey('https://us-east-2.signin.aws.amazon.com/oauth')).toBe('https://signin.aws.amazon.com');
  expect(sameSite('https://eu-west-1.signin.aws.amazon.com', 'https://signin.aws.amazon.com/signin')).toBe(true);
  expect(sameSite('https://ap-southeast-2.signin.aws.amazon.com', 'https://us-gov-west-1.signin.aws.amazon.com')).toBe(true);
  expect(sameSite('https://accounts.google.com', 'https://mail.google.com')).toBe(false);
  expect(sameSite('https://signin.aws.amazon.com', 'https://signin.aws.amazon.com.evil.example')).toBe(false);
  expect(sameSite('https://us-east-2.evil.example', 'https://amazon.com')).toBe(false);
  expect(sameSite('http://signin.aws.amazon.com', 'https://signin.aws.amazon.com')).toBe(false);
  dir = await mkdtemp(join(tmpdir(), 'clikcode-vault-region-'));
  const id = await saveLoginFields(dir, 'https://us-east-2.signin.aws.amazon.com/signin', { accountId: '123456789012', username: 'admin', password: 'x' });
  expect((await savedLoginsForSite(dir, 'https://us-west-2.signin.aws.amazon.com/oauth')).map(login => login.id)).toEqual([id]);
});

it('lists saved logins across sites for the user and removes only the one named', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-vault-manage-'));
  const google = await saveLoginFields(dir, 'https://accounts.google.com/', { username: 'one@example.com', password: 'a' });
  const aws = await saveLoginFields(dir, 'https://signin.aws.amazon.com/', { username: 'admin', password: 'b' });
  expect(await allSavedLogins(dir)).toEqual([
    { id: google, site: 'accounts.google.com', label: 'one@example.com' },
    { id: aws, site: 'signin.aws.amazon.com', label: 'admin' },
  ].sort((a, b) => a.site.localeCompare(b.site)));
  expect(await removeSavedLogin(dir, google)).toBe(true);
  expect(await removeSavedLogin(dir, google)).toBe(false);
  expect((await allSavedLogins(dir)).map(login => login.id)).toEqual([aws]);
  await expect(removeSavedLogin(dir, '../../etc/passwd')).rejects.toThrow('Invalid');
});

it('remembers a refused password, and a new save clears it', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-vault-refused-'));
  const url = 'https://accounts.google.com/';
  const id = await saveLoginFields(dir, url, { username: 'one@example.com', password: 'old' });
  await setLoginRejected(dir, url, id, true);
  expect((await savedLoginsForSite(dir, url))[0]!.rejected).toBe(true);
  await saveLoginFields(dir, url, { password: 'new' }, id);
  expect((await savedLoginsForSite(dir, url))[0]!.rejected).toBe(false);
  expect((await savedLoginFields(dir, url, id)).password).toBe('new');
});

it('keeps one entry for an account saved again, with its newest password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clikcode-vault-same-'));
  try {
    await saveLoginFields(dir, 'https://app.example.com/login', { username: 'Me@Example.com', password: 'first-pass-1' });
    await saveLoginFields(dir, 'https://app.example.com/login', { username: 'me@example.com', password: 'second-pass-2' });
    await saveLoginFields(dir, 'https://app.example.com/login', { username: 'other@example.com', password: 'other-pass-3' });
    const logins = await savedLoginsForSite(dir, 'https://app.example.com/');
    expect(logins).toHaveLength(2);
    const mine = logins.find(login => login.label.toLowerCase() === 'me@example.com')!;
    expect((await savedLoginFields(dir, 'https://app.example.com/', mine.id)).password).toBe('second-pass-2');
  } finally { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); }
});

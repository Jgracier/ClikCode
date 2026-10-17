import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillCredential, loginLabel, lockCredentialVault, saveCredential, saveLoginFields, savedLoginsForSite } from './credential-vault.js';
import type { Page } from 'playwright-core';

let dir = '';
afterEach(async () => { if (dir) { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); dir = ''; } });

it('generates a local key automatically, stores only encrypted records, and fills only the matching HTTPS origin', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-vault-'));
  const secret = 'website-only-secret';
  const id = await saveCredential(dir, 'https://signin.aws.amazon.com/login', {
    accountId: 'account-123', email: 'private@example.com', password: secret,
  });
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
  const filled: Record<string, string> = {};
  const page = (url: string) => ({
    url: () => url,
    locator: (selector: string) => ({ count: async () => 1, fill: async (value: string) => { filled[selector] = value; } }),
    getByRole: () => ({ count: async () => 1, fill: async (value: string) => { filled.account = value; } }),
  }) as unknown as Page;
  await expect(fillCredential(dir, page('https://evil.example/login'), id)).rejects.toThrow('does not match');
  expect(filled).toEqual({});
  lockCredentialVault(dir);
  await fillCredential(dir, page('https://signin.aws.amazon.com/login'), id);
  expect(filled['input[type="password"]:visible']).toBe(secret);
  expect(filled.account).toBe('account-123');
});

it('lists every account saved for a site by username, in order, and never by password', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-vault-accounts-'));
  await saveCredential(dir, 'https://accounts.google.com/', { accountId: '', email: 'two@example.com', password: 'private-password' });
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

it('fills an email-first sign-in without returning the saved password', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-vault-two-step-'));
  const id = await saveCredential(dir, 'https://accounts.google.com', {
    accountId: '', email: 'private@example.com', password: 'website-only-secret',
  });
  let step = 0;
  const filled: string[] = [];
  const page = {
    url: () => 'https://accounts.google.com/signin',
    locator: (selector: string) => ({
      count: async () => selector.includes('password') ? step : 1 - step,
      fill: async (value: string) => { filled.push(value); },
      press: async () => { step = 1; },
      waitFor: async () => undefined,
    }),
    getByRole: () => ({ count: async () => 0 }),
    waitForTimeout: async () => undefined,
  } as unknown as Page;
  await fillCredential(dir, page, id);
  expect(filled).toEqual(['private@example.com', 'website-only-secret']);
});

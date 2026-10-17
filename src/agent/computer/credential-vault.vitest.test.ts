import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillCredential, lockCredentialVault, saveCredential } from './credential-vault.js';
import type { Page } from 'playwright-core';

let dir = '';
afterEach(async () => { if (dir) { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); dir = ''; } });

it('generates a local key automatically, stores only encrypted records, and fills only the matching HTTPS origin', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-vault-'));
  const secret = 'website-only-secret';
  const id = await saveCredential(dir, 'https://signin.aws.amazon.com/login', {
    accountId: 'account-123', email: 'private@example.com', password: secret,
  });
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
    }),
    getByRole: () => ({ count: async () => 0 }),
    waitForTimeout: async () => undefined,
  } as unknown as Page;
  await fillCredential(dir, page, id);
  expect(filled).toEqual(['private@example.com', 'website-only-secret']);
});

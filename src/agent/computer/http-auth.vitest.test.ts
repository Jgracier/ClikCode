import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { lockCredentialVault, saveLoginFields } from './credential-vault.js';
import { httpCredentialsFor } from './http-auth.js';

let dir = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-http-auth-')); });
afterEach(async () => { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); });

it('uses the saved login for the origin, and the one named by label', async () => {
  await saveLoginFields(dir, 'https://files.example.test/', { username: 'ada', password: 'one-pass' });
  await saveLoginFields(dir, 'https://files.example.test/', { username: 'bob', password: 'two-pass' });
  expect(await httpCredentialsFor(dir, 'https://files.example.test/private')).toEqual({ username: 'ada', password: 'one-pass' });
  expect(await httpCredentialsFor(dir, 'https://files.example.test/', { label: 'bob' })).toEqual({ username: 'bob', password: 'two-pass' });
  expect(await httpCredentialsFor(dir, 'https://other.example.test/')).toBeUndefined();
});

it('asks the user once, privately, when nothing is saved, and keeps the answer', async () => {
  let asked = 0;
  const ask = async (site: string, fields: readonly { key: string; kind: string }[]): Promise<Record<string, string>> => {
    asked++;
    expect(site).toBe('https://intranet.example.test');
    expect(fields.map(field => `${field.key}:${field.kind}`)).toEqual(['username:text', 'password:password']);
    return { username: 'carol', password: 'typed-pass' };
  };
  expect(await httpCredentialsFor(dir, 'https://intranet.example.test/a', { ask })).toEqual({ username: 'carol', password: 'typed-pass' });
  expect(await httpCredentialsFor(dir, 'https://intranet.example.test/b', { ask })).toEqual({ username: 'carol', password: 'typed-pass' });
  expect(asked).toBe(1);
});

it('does not take a saved login that the site refused', async () => {
  const { setLoginRejected, savedLoginsForSite } = await import('./credential-vault.js');
  const id = await saveLoginFields(dir, 'https://files.example.test/', { username: 'ada', password: 'bad-pass' });
  await setLoginRejected(dir, 'https://files.example.test/', id, true);
  expect((await savedLoginsForSite(dir, 'https://files.example.test/')).every(login => login.rejected)).toBe(true);
  expect(await httpCredentialsFor(dir, 'https://files.example.test/')).toBeUndefined();
});

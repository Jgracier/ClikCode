import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { lockCredentialVault, namedSecretNames, readNamedSecret, saveNamedSecret } from './credential-vault.js';

let dir = '';
afterEach(async () => { if (dir) { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); dir = ''; } });

it('saves a secret encrypted, reads it back, and lists only names', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-secret-'));
  await saveNamedSecret(dir, 'salad/api-key', 'salad_key_0123456789');
  expect(await readNamedSecret(dir, 'salad/api-key')).toBe('salad_key_0123456789');
  expect(await readNamedSecret(dir, 'SALAD/api-key')).toBe('salad_key_0123456789');
  expect(await namedSecretNames(dir)).toEqual(['salad/api-key']);
  const files = await readdir(join(dir, 'computer', 'vault', 'secrets'));
  expect(files).toHaveLength(1);
  const raw = await readFile(join(dir, 'computer', 'vault', 'secrets', files[0]!), 'utf8');
  expect(raw).not.toContain('salad_key');
  expect(raw).not.toContain('salad/api-key');
});

it('overwrites a secret of the same name and refuses bad names, empty values and missing secrets', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-secret-'));
  await saveNamedSecret(dir, 'a', 'first-value-1');
  await saveNamedSecret(dir, 'a', 'second-value-2');
  expect(await readNamedSecret(dir, 'a')).toBe('second-value-2');
  await expect(saveNamedSecret(dir, '../x', 'v')).rejects.toThrow('secret name');
  await expect(saveNamedSecret(dir, 'b', '')).rejects.toThrow('empty');
  await expect(readNamedSecret(dir, 'nope')).rejects.toThrow('No secret named');
});

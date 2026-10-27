import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { auditVault, canonicalSecretName, deleteNamedSecret, lockCredentialVault, namedSecretNames, readNamedSecret, saveNamedSecret } from './credential-vault.js';
import { exchangeVault, syncVault } from './vault-sync.js';

const dirs: string[] = [];
const fresh = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), 'clikcode-names-')); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); } });

it('gives the spellings of one key a single canonical name, and keeps admin and sandbox keys apart', () => {
  for (const name of ['acme/key', 'Acme/api-key', 'www.acme/secret-key', 'acme/apikey']) expect(canonicalSecretName(name)).toBe('acme/key');
  expect(canonicalSecretName('acme/access-token')).toBe('acme/token');
  expect(canonicalSecretName('acme/admin-key')).toBe('acme/admin-key');
  expect(canonicalSecretName('acme/sandbox-key')).toBe('acme/sandbox-key');
  expect(canonicalSecretName('RAILWAY_API_TOKEN')).toBe('railway_api_token');
});

it('finds a secret by any spelling, saves a variant as a rotation not a twin, and says what is saved when nothing matches', async () => {
  const dir = await fresh();
  await saveNamedSecret(dir, 'acme/api-key', 'value-one-1');
  expect(await readNamedSecret(dir, 'acme/key')).toBe('value-one-1');
  await saveNamedSecret(dir, 'acme/key', 'value-two-2');
  expect(await namedSecretNames(dir)).toEqual(['acme/api-key']);
  expect(await readNamedSecret(dir, 'acme/api-key')).toBe('value-two-2');
  await expect(readNamedSecret(dir, 'acme/client-id')).rejects.toThrow('Saved for that vendor: acme/api-key');
  // A variant never deletes a different key.
  expect(await deleteNamedSecret(dir, 'acme/key')).toBe(false);
  expect(await namedSecretNames(dir)).toEqual(['acme/api-key']);
});

it('saving a second spelling updates the first instead of adding a twin', async () => {
  const dir = await fresh();
  await saveNamedSecret(dir, 'acme/api-key', 'aaaa-1111');
  await saveNamedSecret(dir, 'acme/secret-key', 'bbbb-2222');
  expect(await namedSecretNames(dir)).toEqual(['acme/api-key']);
});

it('audits twins, odd names and secrets with no owner, by name only', async () => {
  const dir = await fresh();
  await saveNamedSecret(dir, 'crusoe/try-a', 'v-1111', { owner: 'me@example.com' });
  await saveNamedSecret(dir, 'RAILWAY_API_TOKEN', 'v-2222');
  const audit = await auditVault(dir);
  expect(audit.oddNames.sort()).toEqual(['RAILWAY_API_TOKEN', 'crusoe/try-a']);
  expect(audit.noOwner).toEqual(['RAILWAY_API_TOKEN']);
});

it('syncs two vaults both ways: each gets what the other has, the newer secret wins, nothing is removed', async () => {
  const a = await fresh(), b = await fresh();
  await saveNamedSecret(a, 'only/a-key', 'from-a-1111');
  await saveNamedSecret(b, 'only/b-key', 'from-b-2222');
  await saveNamedSecret(a, 'both/key', 'old-value-1');
  await new Promise(resolve => setTimeout(resolve, 15));
  await saveNamedSecret(b, 'both/api-key', 'new-value-2');
  const result = await syncVault(a, payload => exchangeVault(b, payload));
  for (const dir of [a, b]) {
    expect(await readNamedSecret(dir, 'only/a-key')).toBe('from-a-1111');
    expect(await readNamedSecret(dir, 'only/b-key')).toBe('from-b-2222');
    expect(await readNamedSecret(dir, 'both/key')).toBe('new-value-2');
  }
  expect((await namedSecretNames(a)).filter(name => name.startsWith('both/'))).toHaveLength(1);
  expect(result.received.added).toBe(1);
  // A second run changes nothing.
  const again = await syncVault(a, payload => exchangeVault(b, payload));
  expect(again.received.added + again.received.updated).toBe(0);
});

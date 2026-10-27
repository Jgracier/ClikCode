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

it('syncs into a computer that has no vault yet, and out of one that has nothing to give', async () => {
  const full = await fresh(), empty = await fresh();
  await saveNamedSecret(full, 'acme/key', 'value-1111');
  const result = await syncVault(full, payload => exchangeVault(empty, payload));
  expect(await readNamedSecret(empty, 'acme/key')).toBe('value-1111');
  expect(result.received.added).toBe(0);
  const back = await fresh();
  await syncVault(back, payload => exchangeVault(full, payload));
  expect(await readNamedSecret(back, 'acme/key')).toBe('value-1111');
});

it('lets an agent list what is saved, names and dates only', async () => {
  const dir = await fresh();
  await saveNamedSecret(dir, 'acme/key', 'value-1111');
  await saveNamedSecret(dir, 'other/client-id', 'value-2222');
  const { accountUseTool } = await import('../tools/computer-web.js');
  const all = await accountUseTool.run({ action: 'secrets' } as never, { stateDir: dir } as never);
  expect(all.output).toContain('2 saved keys');
  expect(all.output).toContain('acme/key');
  expect(all.output).not.toContain('value-1111');
  const some = await accountUseTool.run({ action: 'secrets', target: 'other' } as never, { stateDir: dir } as never);
  expect(some.output).toContain('1 saved key');
  expect(some.output).not.toContain('acme/key');
  expect((await accountUseTool.run({ action: 'secrets', target: 'nothing' } as never, { stateDir: dir } as never)).output).toContain('No saved key matches');
});

it('asks the other computer once more when its first answer is not a vault, and says what came back if the second is not either', async () => {
  const a = await fresh(), b = await fresh();
  await saveNamedSecret(a, 'acme/key', 'value-1111');
  let calls = 0;
  await syncVault(a, payload => (calls++ === 0 ? Promise.resolve('{"status":"error","message":"hiccup"}') : exchangeVault(b, payload)));
  expect(calls).toBe(2);
  expect(await readNamedSecret(b, 'acme/key')).toBe('value-1111');
  await expect(syncVault(a, () => Promise.resolve('{"status":"error","message":"nope"}'))).rejects.toThrow('nope');
});

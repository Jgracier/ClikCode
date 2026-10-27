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
  await saveNamedSecret(dir, 'acme/api-key', 'value-one-1', { url: 'https://example.com' });
  expect(await readNamedSecret(dir, 'acme/key')).toBe('value-one-1');
  await saveNamedSecret(dir, 'acme/key', 'value-two-2', { url: 'https://example.com' });
  expect(await namedSecretNames(dir)).toEqual(['acme/api-key']);
  expect(await readNamedSecret(dir, 'acme/api-key')).toBe('value-two-2');
  await expect(readNamedSecret(dir, 'acme/client-id')).rejects.toThrow('Saved for that vendor: acme/api-key');
  // A variant never deletes a different key.
  expect(await deleteNamedSecret(dir, 'acme/key')).toBe(false);
  expect(await namedSecretNames(dir)).toEqual(['acme/api-key']);
});

it('saving a second spelling updates the first instead of adding a twin', async () => {
  const dir = await fresh();
  await saveNamedSecret(dir, 'acme/api-key', 'aaaa-1111', { url: 'https://example.com' });
  await saveNamedSecret(dir, 'acme/secret-key', 'bbbb-2222', { url: 'https://example.com' });
  expect(await namedSecretNames(dir)).toEqual(['acme/api-key']);
});

it('audits twins, odd names and secrets with no owner, by name only', async () => {
  const dir = await fresh();
  await saveNamedSecret(dir, 'crusoe/try-a', 'v-1111', { owner: 'me@example.com', url: 'https://crusoe.example' });
  await saveNamedSecret(dir, 'RAILWAY_API_TOKEN', 'v-2222', { url: 'https://example.com' });
  const audit = await auditVault(dir);
  expect(audit.oddNames.sort()).toEqual(['RAILWAY_API_TOKEN', 'crusoe/try-a']);
  expect(audit.noOwner).toEqual(['RAILWAY_API_TOKEN']);
});

it('syncs two vaults both ways: each gets what the other has, the newer secret wins, nothing is removed', async () => {
  const a = await fresh(), b = await fresh();
  await saveNamedSecret(a, 'only/a-key', 'from-a-1111', { url: 'https://example.com' });
  await saveNamedSecret(b, 'only/b-key', 'from-b-2222', { url: 'https://example.com' });
  await saveNamedSecret(a, 'both/key', 'old-value-1', { url: 'https://example.com' });
  await new Promise(resolve => setTimeout(resolve, 15));
  await saveNamedSecret(b, 'both/api-key', 'new-value-2', { url: 'https://example.com' });
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
  await saveNamedSecret(full, 'acme/key', 'value-1111', { url: 'https://example.com' });
  const result = await syncVault(full, payload => exchangeVault(empty, payload));
  expect(await readNamedSecret(empty, 'acme/key')).toBe('value-1111');
  expect(result.received.added).toBe(0);
  const back = await fresh();
  await syncVault(back, payload => exchangeVault(full, payload));
  expect(await readNamedSecret(back, 'acme/key')).toBe('value-1111');
});

it('lets an agent list what is saved, names and dates only', async () => {
  const dir = await fresh();
  await saveNamedSecret(dir, 'acme/key', 'value-1111', { url: 'https://example.com' });
  await saveNamedSecret(dir, 'other/client-id', 'value-2222', { url: 'https://example.com' });
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
  await saveNamedSecret(a, 'acme/key', 'value-1111', { url: 'https://example.com' });
  let calls = 0;
  await syncVault(a, payload => (calls++ === 0 ? Promise.resolve('{"status":"error","message":"hiccup"}') : exchangeVault(b, payload)));
  expect(calls).toBe(2);
  expect(await readNamedSecret(b, 'acme/key')).toBe('value-1111');
  await expect(syncVault(a, () => Promise.resolve('{"status":"error","message":"nope"}'))).rejects.toThrow('nope');
});

it('records every login with a name, a base URL and how it signs in, and an OAuth sign-in with the provider and the account used', async () => {
  const dir = await fresh();
  const { allSavedLogins, saveLoginFields, saveSignInMethod, siteName } = await import('./credential-vault.js');
  expect(['https://login.wordnik.com', 'https://www.supabase.com', 'https://app.kit.com', 'https://portal.example.co.uk', 'https://x.com'].map(siteName)).toEqual(['Wordnik', 'Supabase', 'Kit', 'Example', 'X']);
  await saveLoginFields(dir, 'https://supabase.com/dashboard', { email: 'me@example.com', password: 'pw-1234' });
  await saveSignInMethod(dir, 'https://app.netlify.com/login', 'google', 'me@example.com');
  const all = await allSavedLogins(dir);
  expect(all.map(({ name, baseUrl, method, label, complete }) => ({ name, baseUrl, method, label, complete }))).toEqual([
    { name: 'Netlify', baseUrl: 'https://app.netlify.com', method: 'google', label: 'me@example.com', complete: true },
    { name: 'Supabase', baseUrl: 'https://supabase.com', method: 'password', label: 'me@example.com', complete: true },
  ]);
  await expect(saveSignInMethod(dir, 'https://example.com', 'password', 'me@example.com')).rejects.toThrow('provider');
  // A login that has an account but no password is flagged, not hidden.
  await saveLoginFields(dir, 'https://half.example.com', { email: 'me@example.com' }, undefined, { method: 'password' });
  expect((await auditVault(dir)).incompleteLogins.map(login => login.site)).toEqual(['half.example.com']);
});

it('requires every key to say which site it is for, working it out from the name or the vendor\'s login when it can', async () => {
  const dir = await fresh();
  const { saveLoginFields, namedSecretInfo } = await import('./credential-vault.js');
  await expect(saveNamedSecret(dir, 'acme/key', 'value-1111')).rejects.toThrow('which site');
  await saveNamedSecret(dir, 'app.mailgun.com/key', 'value-2222');
  await saveLoginFields(dir, 'https://dashboard.acme.io/login', { email: 'me@example.com', password: 'pw-1234' });
  await saveNamedSecret(dir, 'acme/key', 'value-3333');
  await saveNamedSecret(dir, 'explicit/key', 'value-4444', { url: 'https://api.explicit.dev/v1/keys' });
  await saveNamedSecret(dir, 'profile/abc/password', 'value-5555');
  const urls = Object.fromEntries((await namedSecretInfo(dir)).map(({ name, meta }) => [name, meta?.url]));
  expect(urls).toEqual({ 'app.mailgun.com/key': 'https://app.mailgun.com', 'acme/key': 'https://dashboard.acme.io', 'explicit/key': 'https://api.explicit.dev', 'profile/abc/password': undefined });
  // A second save keeps the site it had.
  await saveNamedSecret(dir, 'explicit/key', 'value-6666');
  expect((await namedSecretInfo(dir)).find(entry => entry.name === 'explicit/key')?.meta?.url).toBe('https://api.explicit.dev');
});

it('lets an agent list the saved sign-ins and record one made through a provider, never showing a password', async () => {
  const dir = await fresh();
  const { saveLoginFields } = await import('./credential-vault.js');
  const { accountUseTool } = await import('../tools/computer-web.js');
  await saveLoginFields(dir, 'https://supabase.com/dashboard', { email: 'me@example.com', password: 'pw-secret-1234' });
  const ctx = { stateDir: dir } as never;
  await accountUseTool.run({ action: 'accounts', target: 'app.netlify.com', method: 'google', fields: { email: 'me@example.com' } } as never, ctx);
  const all = await accountUseTool.run({ action: 'accounts' } as never, ctx);
  expect(all.output).toContain('2 saved sign-ins');
  expect(all.output).toContain('Supabase  https://supabase.com  password  me@example.com');
  expect(all.output).toContain('Netlify  https://app.netlify.com  via google  me@example.com');
  expect(all.output).not.toContain('pw-secret-1234');
  expect((await accountUseTool.run({ action: 'accounts', target: 'nothing' } as never, ctx)).output).toContain('No saved sign-in matches');
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { lockCredentialVault } from './credential-vault.js';
import { syncVault } from './vault-sync.js';

let dir = '';
afterEach(async () => { if (dir) { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); dir = ''; } });

it('never echoes what the other computer answered when it is not a vault: a near-vault reply is plaintext secrets', async () => {
  dir = await mkdtemp(join(tmpdir(), 'vsync-'));
  const plaintext = 'warning: update\n{"v":2,"secrets":[{"name":"stripe","value":"plain-secret-value-123456"}]}';
  const error = await syncVault(dir, async () => plaintext).then(() => undefined, (e: Error) => e);
  expect(error?.message).toContain('not a vault');
  expect(error?.message).not.toContain('plain-secret-value');
  expect(error?.message).not.toContain('stripe');
  const json = await syncVault(dir, async () => '{"v":2,"secrets":[{"name":"x","value":"another-secret-999"}]}').then(() => undefined, (e: Error) => e);
  expect(json?.message).not.toContain('another-secret');
  expect(json?.message).toContain('JSON');
});

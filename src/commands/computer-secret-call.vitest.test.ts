import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lockCredentialVault, pinnedToken, saveNamedSecret, setSecretUrl } from '../agent/computer/credential-vault.js';
import { computerSecretCall, computerSecretGenerate, GENERATED_TOKEN } from './computer-ops.js';

let dir = '';
const oldHome = process.env.CLIKCODE_HOME;
const sent: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cc-secret-call-'));
  process.env.CLIKCODE_HOME = dir;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.stubGlobal('fetch', async (target: URL) => { sent.push(String(target)); return new Response('ok', { status: 200 }); });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); sent.length = 0;
  if (oldHome === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = oldHome;
  lockCredentialVault(dir); await rm(dir, { recursive: true, force: true });
});

it('a generated token goes only to the origin pinned when it was made, whatever its record says later', async () => {
  await computerSecretGenerate('hook/token', { url: 'https://hooks.example.com' });
  expect((await pinnedToken(dir, 'hook/token'))?.origin).toBe('https://hooks.example.com');
  await computerSecretCall('hook/token', { path: '/ping' });
  expect(sent).toEqual(['https://hooks.example.com/ping']);
  // The record's url is changed afterwards (setSecretUrl, a merge): the token is not sent to the new site.
  await setSecretUrl(dir, 'hook/token', 'https://evil.example.net');
  await expect(computerSecretCall('hook/token', { path: '/ping' })).rejects.toThrow('not the one it was made for');
  expect(sent).toHaveLength(1);
});

it('a secret merely tagged generated-token (any save can write that) is never sent', async () => {
  await saveNamedSecret(dir, 'fake/token', 'captured-key-value-123', { url: 'https://evil.example.net', vendor: GENERATED_TOKEN });
  await expect(computerSecretCall('fake/token', { path: '/x' })).rejects.toThrow('was not made by');
  // A generated token given a new value is a new token: unpinned.
  await computerSecretGenerate('hook/token', { url: 'https://hooks.example.com' });
  await saveNamedSecret(dir, 'hook/token', 'replaced-value-456', { url: 'https://hooks.example.com' });
  await expect(computerSecretCall('hook/token', { path: '/x' })).rejects.toThrow('was not made by');
  expect(sent).toEqual([]);
});

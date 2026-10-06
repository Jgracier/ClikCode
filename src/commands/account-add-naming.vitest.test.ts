import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const keyEmail = vi.fn(async (_options: { provider: string; envName: string; key: string | undefined }): Promise<string | undefined> => undefined);
vi.mock('../harness/accounts/api-key-identity.js', () => ({ apiKeyAccountEmail: keyEmail }));
vi.mock('../cli/structured-output.js', () => ({ emitResult: () => undefined }));
vi.mock('../runtime/lazy-bridge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/lazy-bridge.js')>(),
  localHarnessForProvider: () => ({ command: 'codex', displayName: 'Codex', provider: 'openai', binary: 'codex', localAuth: ['api-key', 'vendor-cli'] }),
}));

const { aiAccountAdd } = await import('./account.js');
const { readState } = await import('../session/state/read.js');
const { writeState } = await import('../session/state/write.js');

const previousHome = process.env.CLIKCODE_HOME;
let home = '';
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'clikcode-account-add-'));
  process.env.CLIKCODE_HOME = home;
  process.env.CLIKCODE_TEST_KEY = 'sk-test';
  keyEmail.mockReset();
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  delete process.env.CLIKCODE_TEST_KEY;
  await rm(home, { recursive: true, force: true });
});

describe('naming an added API-key account', () => {
  it('takes the email behind the key, read with the key from its variable', async () => {
    keyEmail.mockResolvedValueOnce('me@example.com');
    expect(await aiAccountAdd({ provider: 'openai', auth: 'api-key', credentialRef: 'env:CLIKCODE_TEST_KEY', placeholder: 'Codex (CLIKCODE_TEST_KEY)' })).toBe('me@example.com');
    expect(keyEmail).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', envName: 'CLIKCODE_TEST_KEY', key: 'sk-test' }));
    expect((await readState()).accounts.map((account) => account.label)).toEqual(['me@example.com']);
  });

  it('suffixes an email another account (any provider) already holds', async () => {
    const state = await readState();
    state.accounts.push({ id: 'login', provider: 'anthropic', label: 'Me@example.com', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:claude' } as typeof state.accounts[number]);
    await writeState(state);
    keyEmail.mockResolvedValueOnce('me@example.com');
    expect(await aiAccountAdd({ provider: 'openai', auth: 'api-key', credentialRef: 'env:CLIKCODE_TEST_KEY' })).toBe('me@example.com (2)');
  });

  it('keeps the placeholder when the vendor names no one, and a given label always', async () => {
    expect(await aiAccountAdd({ provider: 'openai', auth: 'api-key', credentialRef: 'env:CLIKCODE_TEST_KEY', placeholder: 'Codex (CLIKCODE_TEST_KEY)' })).toBe('Codex (CLIKCODE_TEST_KEY)');
    process.env.OTHER_TEST_KEY = 'x';
    try {
      expect(await aiAccountAdd({ provider: 'openai', auth: 'api-key', credentialRef: 'env:OTHER_TEST_KEY' })).toBe('Codex 1');
    } finally { delete process.env.OTHER_TEST_KEY; }
    keyEmail.mockClear();
    expect(await aiAccountAdd({ provider: 'openai', label: 'Work', auth: 'api-key', credentialRef: 'env:THIRD_TEST_KEY' })).toBe('Work');
    expect(keyEmail).not.toHaveBeenCalled();
  });

  it('does not call the vendor for a credential that is already connected', async () => {
    await aiAccountAdd({ provider: 'openai', label: 'First', auth: 'api-key', credentialRef: 'env:CLIKCODE_TEST_KEY' });
    await expect(aiAccountAdd({ provider: 'openai', auth: 'api-key', credentialRef: 'env:CLIKCODE_TEST_KEY' })).rejects.toThrow('already connected');
    expect(keyEmail).not.toHaveBeenCalled();
  });
});

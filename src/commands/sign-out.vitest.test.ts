import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const vendorLogout = vi.fn(async (): Promise<void> => undefined);
vi.mock('../harness/accounts/auth-files.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../harness/accounts/auth-files.js')>(),
  harnessCanLogout: () => true,
  logoutNativeHarness: vendorLogout,
}));

vi.mock('../runtime/lazy-bridge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/lazy-bridge.js')>(),
  localHarnessForProvider: () => ({ command: 'codex', displayName: 'Codex', provider: 'openai', binary: 'codex', profileEnv: 'CODEX_HOME' }),
  homeRedirectEnvironment: (_harness: unknown, base: Record<string, string>) => ({ ...base }),
}));

const { signOutAccount } = await import('./account.js');
const { readState } = await import('../session/state/read.js');
const { writeState } = await import('../session/state/write.js');

const previousHome = process.env.CLIKCODE_HOME;
afterEach(() => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
});

async function signedInAccount(): Promise<void> {
  process.env.CLIKCODE_HOME = await mkdtemp(join(tmpdir(), 'clikcode-signout-'));
  const state = await readState();
  state.accounts.push({ id: 'acct', provider: 'openai', label: 'Work', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:codex', signedInAt: '2026-09-01T00:00:00.000Z' } as typeof state.accounts[number]);
  await writeState(state);
}

describe('sign-out', () => {
  it('runs the vendor logout and retires the sign-in a live vendor child holds', async () => {
    await signedInAccount();
    await signOutAccount('acct');
    expect(vendorLogout).toHaveBeenCalledOnce();
    const account = (await readState()).accounts.find((item) => item.id === 'acct');
    expect(account?.status).toBe('needs_login');
    expect(account?.signedInAt).toBeUndefined();
  });

  it('leaves the account signed in when the vendor refuses the logout', async () => {
    await signedInAccount();
    vendorLogout.mockRejectedValueOnce(new Error('codex exited 1'));
    await expect(signOutAccount('acct')).rejects.toThrow('codex exited 1');
    expect((await readState()).accounts.find((item) => item.id === 'acct')?.status).toBe('ready');
  });
});

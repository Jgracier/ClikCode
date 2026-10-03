import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../harness/transport/native/login.js', () => ({
  loginNativeHarness: vi.fn(async () => { throw new Error('sign-in cancelled'); }),
}));

const previousHome = process.env.CLIKCODE_HOME;
afterEach(() => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
});

describe('account sign-in profiles', () => {
  it('removes the profile a failed sign-in created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-login-'));
    process.env.CLIKCODE_HOME = root;
    try {
      const { aiAccountLogin } = await import('./account.js');
      await expect(aiAccountLogin('codex')).rejects.toThrow('sign-in cancelled');
      expect(await readdir(join(root, 'profiles', 'codex')).catch(() => [])).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

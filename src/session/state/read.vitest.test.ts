import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from './read.js';

const previousHome = process.env.CLIKCODE_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
});

describe('harness state normalization', () => {
  it('does not reintroduce a local permission override on Gateway sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-state-'));
    process.env.CLIKCODE_HOME = root;
    const now = new Date().toISOString();
    await writeFile(join(root, 'harness-state.json'), `${JSON.stringify({
      version: 1,
      installationId: 'install',
      localApiToken: 'token',
      devicePrivateKeyPem: 'private',
      devicePublicKey: { kty: 'OKP' },
      accounts: [],
      sessions: [
        { id: 'gateway', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'ask', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active' },
        { id: 'local', route: 'local', accountId: null, provider: null, model: null, effort: 'medium', permissionMode: 'workspace-write', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active' },
      ],
      invocations: [],
      globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' },
      providerSettings: {},
    }, null, 2)}\n`);
    try {
      const state = await readState();
      expect(state.sessions.find((session) => session.id === 'gateway')?.permissionMode).toBeUndefined();
      expect(state.sessions.find((session) => session.id === 'local')?.permissionMode).toBe('ask');
      expect(state.sessions.find((session) => session.id === 'gateway')?.conversationId).toBe('gateway');
      expect(state.sessions.find((session) => session.id === 'local')?.conversationId).toBe('local');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from './read.js';
import { writeState } from './write.js';

const previousHome = process.env.CLIKCODE_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
});

/** Stores an index as an older build left it: what readState normalizes. */
async function storedIndex(root: string, index: { accounts?: unknown[]; sessions?: unknown[] }): Promise<void> {
  await writeFile(join(root, 'index.json'), `${JSON.stringify({
    version: 2, installationId: 'install', devicePublicKey: { kty: 'OKP' },
    accounts: [], sessions: [], invocations: [], invocationRollups: {},
    globalSettings: { effort: 'medium', permissionMode: 'ask' }, providerSettings: {},
    ...index,
  }, null, 2)}\n`);
}

describe('harness state normalization', () => {
  it('keeps a Gateway session\'s approval setting, which its local agent honours', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-state-'));
    process.env.CLIKCODE_HOME = root;
    const now = new Date().toISOString();
    await storedIndex(root, {
      sessions: [
        { id: 'gateway', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass', createdAt: now, updatedAt: now, status: 'active' },
        { id: 'local', route: 'local', accountId: null, provider: null, model: null, effort: 'medium', permissionMode: 'workspace-write', createdAt: now, updatedAt: now, status: 'active' },
      ],
    });
    try {
      const state = await readState();
      expect(state.sessions.find((session) => session.id === 'gateway')?.permissionMode).toBe('bypass');
      expect(state.sessions.find((session) => session.id === 'local')?.permissionMode).toBe('ask');
      expect(state.sessions.find((session) => session.id === 'gateway')?.conversationId).toBe('gateway');
      expect(state.sessions.find((session) => session.id === 'local')?.conversationId).toBe('local');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores the estimate an older build kept on an account, and keeps the vendor\'s own reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-state-'));
    process.env.CLIKCODE_HOME = root;
    const now = new Date().toISOString();
    const base = { provider: 'openai', authKind: 'vendor-cli', models: [], status: 'ready' };
    await storedIndex(root, {
      accounts: [
        { ...base, id: 'estimated', label: 'estimated', credentialRef: 'native:e', usageLearning: { turns: [[Date.now() - 60_000, 100]], hits: [{ at: now, costs: { '5h': 100 } }] } },
        { ...base, id: 'vendor', label: 'vendor', credentialRef: 'native:v',
          usage: { at: now, label: '5h 99% left', windows: [{ name: '5h', usedPct: 1 }] } },
      ],
    });
    try {
      const state = await readState();
      const estimated = state.accounts.find((account) => account.id === 'estimated') as Record<string, unknown> | undefined;
      expect(estimated).toBeDefined();
      expect(estimated).not.toHaveProperty('usageLearning');
      expect(state.accounts.find((account) => account.id === 'vendor')?.usage?.label).toBe('5h 99% left');
      // And it does not come back on the next write.
      state.accounts.find((account) => account.id === 'vendor')!.label = 'renamed';
      await writeState(state);
      expect(await readFile(join(root, 'index.json'), 'utf8')).not.toContain('usageLearning');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

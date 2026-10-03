import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from './read.js';
import { writeState } from './write.js';

const previousHome = process.env.CLIKCODE_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
});

describe('harness state normalization', () => {
  it('keeps a Gateway session\'s approval setting, which its local agent honours', async () => {
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
        { id: 'gateway', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active' },
        { id: 'local', route: 'local', accountId: null, provider: null, model: null, effort: 'medium', permissionMode: 'workspace-write', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active' },
      ],
      invocations: [],
      globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' },
      providerSettings: {},
    }, null, 2)}\n`);
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

  it('drops a usage estimate an older build stored and its high-water limit, and keeps the vendor\'s own reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-state-'));
    process.env.CLIKCODE_HOME = root;
    const now = new Date().toISOString();
    const base = { provider: 'openai', authKind: 'vendor-cli', models: [], status: 'ready' };
    await writeFile(join(root, 'harness-state.json'), `${JSON.stringify({
      version: 1, installationId: 'install', localApiToken: 'token', devicePrivateKeyPem: 'private', devicePublicKey: { kty: 'OKP' },
      accounts: [
        { ...base, id: 'estimated', label: 'estimated', credentialRef: 'native:e', usageLearning: { highWater: { weekly: 1 }, hits: [] },
          usage: { at: now, label: 'Weekly 0% left', learned: true, windows: [{ name: 'weekly', usedPct: 100 }] } },
        { ...base, id: 'vendor', label: 'vendor', credentialRef: 'native:v',
          usage: { at: now, label: '5h 99% left', windows: [{ name: '5h', usedPct: 1 }] } },
      ],
      sessions: [], invocations: [],
      globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' }, providerSettings: {},
    }, null, 2)}\n`);
    try {
      const state = await readState();
      const estimated = state.accounts.find((account) => account.id === 'estimated') as Record<string, unknown> | undefined;
      // Its refusals stay; the faulty high-water "limit" does not.
      expect(estimated?.usageLearning).toEqual({ turns: [], hits: [] });
      expect(estimated?.usage).toBeUndefined();
      expect(state.accounts.find((account) => account.id === 'vendor')?.usage?.label).toBe('5h 99% left');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps learning two processes recorded on one account, whichever writes last', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-state-'));
    process.env.CLIKCODE_HOME = root;
    const now = Date.now();
    await writeFile(join(root, 'harness-state.json'), `${JSON.stringify({
      version: 1, installationId: 'install', localApiToken: 'token', devicePrivateKeyPem: 'private', devicePublicKey: { kty: 'OKP' },
      accounts: [{ id: 'a', provider: 'antigravity', label: 'a', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:a',
        usageLearning: { turns: [[now - 60_000, 100]], hits: [] } }],
      sessions: [], invocations: [],
      globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' }, providerSettings: {},
    }, null, 2)}\n`);
    try {
      // Two windows read the same account, each records something, each saves.
      const first = await readState();
      const second = await readState();
      const at = new Date(now).toISOString();
      first.accounts[0]!.usageLearning = { ...first.accounts[0]!.usageLearning!, hits: [{ at, costs: { '5h': 100 } }] };
      second.accounts[0]!.usageLearning = { ...second.accounts[0]!.usageLearning!, turns: [...second.accounts[0]!.usageLearning!.turns, [now - 30_000, 100]] };
      await writeState(first);
      await writeState(second);
      const learning = (await readState()).accounts[0]!.usageLearning!;
      expect(learning.hits.map((hit) => hit.at)).toEqual([at]);
      expect(learning.turns).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
